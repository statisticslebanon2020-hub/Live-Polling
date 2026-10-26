const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const questionsPath = path.join(__dirname, 'questions.json');
const dataDir = path.join(__dirname, 'data');
const votesPath = path.join(dataDir, 'responses.json');
fs.mkdirSync(dataDir, { recursive: true });
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const useSupabase = !!(supabaseUrl && supabaseSecretKey);

function loadQuestions() {
  const data = JSON.parse(fs.readFileSync(questionsPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(data.questions) || data.questions.length === 0) throw new Error('questions.json must contain at least one question');
  for (const q of data.questions) {
    if (!q.id || !q.text || !Array.isArray(q.options) || q.options.length < 2) throw new Error('Each question needs an id, text, and at least two options');
  }
  return data.questions;
}
let questions = loadQuestions();
let votes = {};
let formSubmissions = {};
let activeIndex = 0;
function isSecureRequest(req) { return req.secure || req.get('x-forwarded-proto') === 'https'; }
function getCookie(req, name) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }))[name] || '';
}
function hasPresenterSession(req) {
  const secret = process.env.PRESENTER_KEY;
  if (!secret) return false;
  const token = getCookie(req, 'live-poll-presenter');
  const [issuedAt, signature, extra] = token.split('.');
  if (extra !== undefined || !/^\d+$/.test(issuedAt || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (age < 0 || age > 43200) return false;
  const expected = crypto.createHmac('sha256', secret).update(issuedAt).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
function requirePresenter(req, res, next) {
  if (!hasPresenterSession(req)) return res.status(401).json({ error: 'Presenter login required.' });
  next();
}

function publicState(questionId = questions[activeIndex]?.id) {
  const questionIndex = questions.findIndex(item => item.id === questionId);
  const question = questionIndex >= 0 ? questions[questionIndex] : null;
  const counts = question ? question.options.map((option, optionIndex) => question.type === 'registration'
    ? Object.values(formSubmissions).filter(entry => entry.topic === option).length
    : Object.values(votes[question.id] || {}).filter(v => v.optionIndex === optionIndex).length
  ) : [];
  return { question, activeIndex: questionIndex >= 0 ? questionIndex : activeIndex, questionCount: questions.length, isOpen: true, counts, total: counts.reduce((a, b) => a + b, 0) };
}
function participantId(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }));
  let id = cookies['live-poll-participant'];
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.append('Set-Cookie', `live-poll-participant=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  return id;
}
function persist() {
  if (useSupabase) return;
  const temporary = `${votesPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ votes, formSubmissions }, null, 2));
  fs.renameSync(temporary, votesPath);
}
async function databaseRequest(resource, method = 'GET', rows) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: supabaseSecretKey,
      Authorization: `Bearer ${supabaseSecretKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: rows === undefined ? undefined : JSON.stringify(rows)
  });
  if (!response.ok) {
    const error = new Error(`Database request failed (${response.status}).`);
    error.status = response.status;
    error.details = await response.text();
    throw error;
  }
  const responseBody = await response.text();
  if (!responseBody.trim()) return null;
  return JSON.parse(responseBody);
}
function storageSnapshot(voteData, submissionData) {
  return JSON.stringify({
    votes: Object.keys(voteData).sort().map(questionId => [questionId,
      Object.keys(voteData[questionId]).sort().map(respondentId => [
        respondentId,
        voteData[questionId][respondentId].optionIndex,
        voteData[questionId][respondentId].at
      ])
    ]),
    submissions: Object.keys(submissionData).sort().map(respondentId => [
      respondentId,
      submissionData[respondentId].topic
    ])
  });
}
async function refreshStorageFromSupabase() {
  const rows = await databaseRequest('responses?select=question_id,respondent_id,option_index,submitted_at');
  const submissions = await databaseRequest('form_submissions?select=respondent_id,topic');
  const nextVotes = {};
  const nextSubmissions = {};
  for (const row of rows) {
    nextVotes[row.question_id] ||= {};
    nextVotes[row.question_id][row.respondent_id] = { optionIndex: row.option_index, at: row.submitted_at };
  }
  for (const row of submissions) nextSubmissions[row.respondent_id] = row;

  const changed = storageSnapshot(votes, formSubmissions) !== storageSnapshot(nextVotes, nextSubmissions);
  votes = nextVotes;
  formSubmissions = nextSubmissions;
  if (changed) {
    for (const question of questions) sendState(question.id);
    console.log('Response data refreshed from Supabase.');
  }
  return rows.length;
}
async function initializeStorage() {
  if ((supabaseUrl && !supabaseSecretKey) || (!supabaseUrl && supabaseSecretKey)) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY, or remove both to use local file storage.');
  }
  if (useSupabase) {
    const responseCount = await refreshStorageFromSupabase();
    console.log(`Loaded ${responseCount} responses from Supabase.`);
  } else if (fs.existsSync(votesPath)) {
    const saved = JSON.parse(fs.readFileSync(votesPath, 'utf8'));
    if (saved && saved.votes) { votes = saved.votes; formSubmissions = saved.formSubmissions || {}; }
    else votes = saved;
  }
}
function sendState(questionId) {
  if (questionId) io.to(questionId).emit('state', publicState(questionId));
}
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/api/state', async (req, res) => {
  const id = participantId(req, res);
  const requestedId = typeof req.query.questionId === 'string' ? req.query.questionId : questions[activeIndex]?.id;
  const state = questions.some(question => question.id === requestedId) ? publicState(requestedId) : publicState();
  const freshState = publicState(state.question?.id);
  const hasAnswered = freshState.question?.type === 'registration'
    ? !!formSubmissions[id]
    : !!(freshState.question && votes[freshState.question.id]?.[id]);
  res.json({ ...freshState, hasAnswered });
});
app.get('/api/presenter/session', (req, res) => res.json({ authenticated: hasPresenterSession(req) }));
app.post('/api/presenter/login', (req, res) => {
  const expected = process.env.PRESENTER_KEY;
  const supplied = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!expected) return res.status(503).json({ error: 'Presenter key is not configured on the hosting service.' });
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ error: 'Incorrect presenter key.' });
  }
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', expected).update(issuedAt).digest('hex');
  const token = `${issuedAt}.${signature}`;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `live-poll-presenter=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
  res.json({ ok: true });
});
app.post('/api/vote', async (req, res) => {
  const { questionId, optionIndex } = req.body || {};
  const state = publicState(questionId);
  if (!state.question) return res.status(409).json({ error: 'This question is unavailable.' });
  if (state.question.type === 'registration') return res.status(400).json({ error: 'Submit this page using the registration form.' });
  const id = participantId(req, res);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= state.question.options.length) return res.status(400).json({ error: 'Choose one of the listed options.' });
  votes[questionId] ||= {};
  if (votes[questionId][id]) return res.status(409).json({ error: 'You have already answered this question.' });
  const submittedAt = new Date().toISOString();
  if (useSupabase) {
    try {
      await databaseRequest('responses', 'POST', [{
        question_id: questionId,
        question_text: state.question.text,
        option_index: optionIndex,
        option_text: state.question.options[optionIndex],
        respondent_id: id,
        submitted_at: submittedAt
      }]);
    } catch (error) {
      if (error.status === 409) return res.status(409).json({ error: 'You have already answered this question.' });
      console.error('Could not save response to Supabase:', error.message, error.details || '');
      return res.status(503).json({ error: 'Could not save your response. Please try again.' });
    }
  }
  votes[questionId][id] = { optionIndex, at: submittedAt };
  persist(); sendState(questionId); res.json({ ok: true });
});
app.post('/api/form-submission', async (req, res) => {
  const question = questions.find(item => item.type === 'registration');
  if (!question) return res.status(404).json({ error: 'The registration form is unavailable.' });
  const id = participantId(req, res);
  if (formSubmissions[id]) return res.status(409).json({ error: 'You have already submitted this form.' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const surname = typeof body.surname === 'string' ? body.surname.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const certificate = body.certificate;
  const topic = typeof body.topic === 'string' ? body.topic : '';
  const topicOther = typeof body.topicOther === 'string' ? body.topicOther.trim() : '';
  if (!name || !surname || !/^\d{8}$/.test(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter your name, surname, valid email, and an 8-digit phone number.' });
  }
  if (!['yes', 'no'].includes(certificate)) return res.status(400).json({ error: 'Choose whether you want a certificate of attendance.' });
  if (!question.options.includes(topic)) return res.status(400).json({ error: 'Choose a topic for the next seminar.' });
  const isOtherTopic = topic === 'غيره، حدد:';
  if (isOtherTopic && !topicOther) return res.status(400).json({ error: 'Specify the other topic.' });
  const submission = {
    respondent_id: id,
    name,
    surname,
    phone,
    email,
    certificate_of_attendance: certificate === 'yes',
    topic,
    topic_other: isOtherTopic ? topicOther : null,
    submitted_at: new Date().toISOString()
  };
  if (useSupabase) {
    try { await databaseRequest('form_submissions', 'POST', [submission]); }
    catch (error) {
      if (error.status === 409) return res.status(409).json({ error: 'You have already submitted this form.' });
      console.error('Could not save registration form:', error.message);
      return res.status(503).json({ error: 'Could not save your form. Please try again.' });
    }
  }
  formSubmissions[id] = submission;
  persist(); sendState(question.id); res.json({ ok: true });
});
app.post('/api/presenter/control', async (req, res) => {
  const { action } = req.body || {};
  if (!hasPresenterSession(req)) return res.status(401).json({ error: 'Presenter login required.' });
  const currentQuestion = questions[activeIndex];
  if (action === 'next' || action === 'previous') {
    activeIndex = Math.max(0, Math.min(questions.length - 1, activeIndex + (action === 'next' ? 1 : -1)));
  } else return res.status(400).json({ error: 'Unknown control action.' });
  if (currentQuestion) sendState(currentQuestion.id);
  if (action === 'next' || action === 'previous') sendState(questions[activeIndex]?.id);
  res.json(publicState());
});
app.get('/api/qr', async (req, res) => {
  try {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    let base = process.env.PUBLIC_URL || `${protocol}://${req.get('host')}`;
    if (!process.env.PUBLIC_URL && ['localhost', '127.0.0.1'].includes(req.hostname)) {
      const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal);
      const localAddress = addresses.find(item => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
      if (localAddress) base = `${protocol}://${localAddress}:${PORT}`;
    }
    base = base.replace(/\/$/, '');
    const questionId = typeof req.query.questionId === 'string' && questions.some(question => question.id === req.query.questionId)
      ? req.query.questionId
      : questions[activeIndex]?.id;
    const respondentUrl = `${base}/?questionId=${encodeURIComponent(questionId)}`;
    const dataUrl = await QRCode.toDataURL(respondentUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ dataUrl, respondentUrl });
  } catch (error) { res.status(500).json({ error: 'Could not create QR code.' }); }
});
io.on('connection', socket => {
  const questionId = typeof socket.handshake.query.questionId === 'string' ? socket.handshake.query.questionId : '';
  let watchedQuestionId = '';
  if (questions.some(question => question.id === questionId)) {
    socket.join(questionId); watchedQuestionId = questionId;
    socket.emit('state', publicState(questionId));
  } else socket.emit('state', publicState());
  socket.on('watchQuestion', nextQuestionId => {
    if (typeof nextQuestionId !== 'string' || !questions.some(question => question.id === nextQuestionId)) return;
    if (watchedQuestionId) socket.leave(watchedQuestionId);
    watchedQuestionId = nextQuestionId;
    socket.join(watchedQuestionId);
    socket.emit('state', publicState(watchedQuestionId));
  });
});
initializeStorage().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`Live polling ready on port ${PORT}`));
  if (useSupabase) {
    const refreshTimer = setInterval(() => {
      refreshStorageFromSupabase().catch(error => {
        console.error('Could not refresh response storage from Supabase:', error.message);
      });
    }, 5000);
    refreshTimer.unref();
  }
}).catch(error => {
  console.error('Could not initialize response storage:', error.message);
  process.exit(1);
});

