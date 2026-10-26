const $ = id => document.getElementById(id);
document.querySelectorAll('.brand span:last-child').forEach(el => { el.textContent = 'Peace & Prosperity'; });
document.querySelectorAll('.brand-mark').forEach(el => { el.textContent = '1'; });
document.title = 'Peace & Prosperity · Report';
const socket = io();
let state;
let authenticated = false;
let qrQuestionId = null;
let watchedQuestionId = null;
let loading = false;
let lastResultsSignature = null;
let lastResultsUpdatedAt = 0;
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function showNotice(message, error = false) { const el = $('notice'); el.hidden = !message; el.textContent = message || ''; el.classList.toggle('error', error); }
function updateResultRows(results, s, updateBars = true) {
  const q = s.question;
  if (!q) return;
  const highestCount = Math.max(0, ...s.counts);
  q.options.forEach((option, i) => {
    const row = results.children[i];
    if (!row) return;
    const count = s.counts[i] || 0;
    const isLeading = count > 0 && count === highestCount;
    row.classList.toggle('is-leading', isLeading);
    const percent = s.total ? Math.round(count / s.total * 100) : 0;
    row.querySelector('.result-label span:last-child').textContent = `${count} · ${percent}%`;
    if (updateBars) {
      const bar = row.querySelector('.bar');
      const from = bar.getBoundingClientRect().width;
      const to = bar.parentElement.getBoundingClientRect().width * percent / 100;
      bar.getAnimations().forEach(animation => animation.cancel());
      bar.style.transition = 'background-color 260ms ease, filter 220ms ease';
      bar.style.width = `${percent}%`;
      if (Math.abs(to - from) > 0.5) {
        bar.animate(
          [{ width: `${from}px` }, { width: `${to}px` }],
          { duration: 700, easing: 'cubic-bezier(.22,.61,.36,1)' }
        );
      }
    }
  });
}
function render(s) {
  if (!authenticated) return;
  state = s; const q = s.question;
  if (q && q.id !== watchedQuestionId) {
    watchedQuestionId = q.id;
    socket.emit('watchQuestion', q.id);
  }
  $('progress').hidden = true;
  if (q) document.querySelector('#dashboard .brand-mark').textContent = String(s.activeIndex + 1);
  if (q && q.id !== qrQuestionId) {
    qrQuestionId = q.id;
    fetch(`/api/qr?questionId=${encodeURIComponent(q.id)}`).then(r => r.json()).then(data => {
      $('qr').src = data.dataUrl; $('respondent-link').href = data.respondentUrl; $('respondent-link').textContent = data.respondentUrl;
    }).catch(() => showNotice('Could not load the QR code.', true));
  }

  $('question').textContent = q ? q.text : 'No question is configured.';

  $('total').textContent = `${s.total} ${s.total === 1 ? 'response' : 'responses'}`;
  const resultsSignature = q ? `${q.id}|${s.total}|${s.counts.join(',')}` : '';
  if (resultsSignature !== lastResultsSignature) {
    lastResultsSignature = resultsSignature;
    lastResultsUpdatedAt = Date.now();
  }
  updateLastResultsText();
  const results = $('results');
  const questionId = q ? q.id : '';
  const questionChanged = results.dataset.questionId !== questionId;
  if (questionChanged) {
    results.replaceChildren();
    results.dataset.questionId = questionId;
    if (q) q.options.forEach(option => {
      const row = document.createElement('div'); row.className = 'result-row';
      const label = document.createElement('div'); label.className = 'result-label';
      const name = document.createElement('span'); name.textContent = option;
      const stat = document.createElement('span'); label.append(name, stat);
      const track = document.createElement('div'); track.className = 'track';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = '0%';
      track.append(bar); row.append(label, track); results.append(row);
    });
  }
  if (q) {
    updateResultRows(results, s, !questionChanged);
    if (questionChanged) requestAnimationFrame(() => {
      if (results.dataset.questionId === questionId && state?.question?.id === questionId) updateResultRows(results, state);
    });
  }

  document.querySelector('[data-action="previous"]').disabled = s.activeIndex <= 0;
  document.querySelector('[data-action="next"]').disabled = s.activeIndex >= s.questionCount - 1;
}
async function load() {
  if (!authenticated || loading) return;
  loading = true;
  try {
    state = await api('/api/state'); render(state); showNotice('');
  } catch (error) { showNotice(error.message, true); }
  finally { loading = false; }
}
document.querySelector('.controls').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  try { render(await api('/api/presenter/control', { method: 'POST', body: JSON.stringify({ action }) })); showNotice(''); }
  catch (error) { showNotice(error.message, true); }
});
document.addEventListener('keydown', event => {
  if (!authenticated || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return;
  const action = event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null;
  if (!action) return;
  event.preventDefault();
  const button = document.querySelector(`[data-action="${action}"]`);
  if (button && !button.disabled) button.click();
});
let queuedLiveState = null;
let liveRenderQueued = false;
function queueLiveRender(s) {
  queuedLiveState = s;
  if (liveRenderQueued) return;
  liveRenderQueued = true;
  requestAnimationFrame(() => {
    liveRenderQueued = false;
    const latestState = queuedLiveState;
    queuedLiveState = null;
    if (latestState) render(latestState);
  });
}
socket.on('state', s => {
  if (authenticated && state?.question?.id === s.question?.id) queueLiveRender(s);
});
socket.on('connect', () => { if (authenticated) load(); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('login-message');
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  message.textContent = '';
  try {
    await api('/api/presenter/login', { method: 'POST', body: JSON.stringify({ key: $('presenter-key').value }) });
    authenticated = true;
    $('presenter-key').value = '';
    $('presenter-login').remove();
    $('dashboard').hidden = false;
    await load();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
    $('presenter-key').focus();
  }
});

async function restorePresenterSession() {
  try {
    const response = await fetch('/api/presenter/session', { cache: 'no-store' });
    const session = await response.json();
    if (!session.authenticated) return;
    authenticated = true;
    $('presenter-login').remove();
    $('dashboard').hidden = false;
    await load();
  } catch (_) {
    // Keep the login form available if the session check cannot reach the server.
  }
}
restorePresenterSession();
function updateLastResultsText() {
  const updated = $('updated');
  if (!updated || !lastResultsUpdatedAt) return;
  const seconds = Math.floor((Date.now() - lastResultsUpdatedAt) / 1000);
  updated.textContent = seconds < 5 ? 'Updated just now' : `Updated ${seconds} seconds ago`;
}
setInterval(updateLastResultsText, 5000);
const fullscreenButton = $('fullscreen-toggle');
fullscreenButton?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (_) { showNotice('Full screen is unavailable in this browser.', true); }
});
document.addEventListener('fullscreenchange', () => {
  const isFullscreen = Boolean(document.fullscreenElement);
  if (!fullscreenButton) return;
  fullscreenButton.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
  fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit full screen' : 'Enter full screen');
});
setInterval(load, 5000);
