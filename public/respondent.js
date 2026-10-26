const $ = id => document.getElementById(id);
document.querySelectorAll('.brand span:last-child').forEach(el => { el.textContent = 'Peace & Prosperity'; });
document.querySelectorAll('.brand-mark').forEach(el => { el.textContent = '1'; });
document.title = 'Peace & Prosperity · Poll';
let socket;
let questionId = new URLSearchParams(location.search).get('questionId');
let state;
let serverAnsweredQuestionId = null;
let selectedOptionIndex = null;
let submitting = false;
let submitted = false;
let formDraft = { name: '', surname: '', phone: '', email: '', certificate: '', topic: '', topicOther: '' };
function showThankYou() {
  $('message').textContent = 'Thanks for participating, your answer has been recorded.';
  const dialog = document.createElement('dialog'); dialog.className = 'thank-dialog';
  const heading = document.createElement('h2'); heading.textContent = 'Thank you';
  const text = document.createElement('p'); text.textContent = 'Thanks for participating, your answer has been recorded.';
  const close = document.createElement('button'); close.className = 'button primary'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
  dialog.append(heading, text, close); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
function rememberFormDraft(options) {
  for (const key of ['name', 'surname', 'phone', 'email', 'topicOther']) {
    const input = options.querySelector(`#form-${key}`);
    if (input) formDraft[key] = input.value;
  }
  const certificate = options.querySelector('input[name="certificate"]:checked');
  const topic = options.querySelector('input[name="form-topic"]:checked');
  if (certificate) formDraft.certificate = certificate.value;
  if (topic) formDraft.topic = topic.value;
}
function addTextField(container, id, labelText, attrs = {}, disabled = false) {
  const field = document.createElement('div'); field.className = 'form-field';
  const label = document.createElement('label'); label.htmlFor = `form-${id}`; label.textContent = labelText;
  const input = document.createElement('input'); input.id = `form-${id}`; input.className = 'text-input'; input.name = id;
  for (const [key, value] of Object.entries(attrs)) input.setAttribute(key, value);
  input.disabled = disabled;
  input.value = formDraft[id] || '';
  field.append(label, input); container.append(field); return input;
}
function addChoiceFieldset(container, legendText, name, choices, selected, disabled, onChange) {
  const fieldset = document.createElement('fieldset'); fieldset.className = 'form-field choice-field';
  const legend = document.createElement('legend'); legend.textContent = legendText; fieldset.append(legend);
  const group = document.createElement('div'); group.className = 'choice-group';
  choices.forEach((choice, index) => {
    const label = document.createElement('label'); label.className = 'option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = choice.value;
    input.required = index === 0; input.disabled = disabled; input.checked = choice.value === selected;
    input.addEventListener('change', onChange);
    const text = document.createElement('span'); text.textContent = choice.label;
    label.append(input, text); group.append(label);
  });
  fieldset.append(group); container.append(fieldset);
}
function renderRegistrationForm(q, options, locked) {
  addTextField(options, 'name', 'الاسم:', { type: 'text', autocomplete: 'given-name', required: '' }, locked);
  addTextField(options, 'surname', 'الشهرة:', { type: 'text', autocomplete: 'family-name', required: '' }, locked);
  addTextField(options, 'phone', 'رقم الهاتف:', { type: 'text', inputmode: 'numeric', autocomplete: 'tel-national', pattern: '[0-9]{8}', minlength: '8', maxlength: '8', required: '' }, locked);
  addTextField(options, 'email', 'البريد الالكتروني:', { type: 'email', autocomplete: 'email', required: '' }, locked);
  addChoiceFieldset(options, 'هل تريد أن تحصل على شهادة حضور Certificate of attendance؟', 'certificate', [
    { value: 'yes', label: 'نعم' }, { value: 'no', label: 'كلا' }
  ], formDraft.certificate, locked, event => { formDraft.certificate = event.target.value; });
  addChoiceFieldset(options, q.text, 'form-topic', q.options.map(option => ({ value: option, label: option })), formDraft.topic, locked, event => {
    formDraft.topic = event.target.value;
    const other = options.querySelector('#form-topicOther-wrap');
    const isOther = event.target.value === 'غيره، حدد:';
    other.hidden = !isOther;
    const input = other.querySelector('input'); input.required = isOther;
  });
  const otherField = document.createElement('div'); otherField.className = 'form-field'; otherField.id = 'form-topicOther-wrap';
  otherField.hidden = formDraft.topic !== 'غيره، حدد:';
  const otherLabel = document.createElement('label'); otherLabel.htmlFor = 'form-topicOther'; otherLabel.textContent = 'غيره، حدد:';
  const otherInput = document.createElement('input'); otherInput.id = 'form-topicOther'; otherInput.className = 'text-input'; otherInput.name = 'topicOther'; otherInput.type = 'text';
  otherInput.value = formDraft.topicOther; otherInput.disabled = locked; otherInput.required = formDraft.topic === 'غيره، حدد:';
  otherField.append(otherLabel, otherInput); options.append(otherField);
}
function render(s) {
  if (!s.question || (questionId && s.question.id !== questionId)) return;
  state = s;
  const q = s.question;
  questionId ||= q.id;
  $('progress').hidden = true;
  document.querySelector('.respondent .brand-mark').textContent = String(s.activeIndex + 1);
  $('question').textContent = q ? (q.formTitle || q.text) : 'No question is configured.';
  const form = $('answer-form'); const options = $('options');
  if (q.type === 'registration') rememberFormDraft(options);
  const checked = options.querySelector('input[name="answer"]:checked');
  if (checked) selectedOptionIndex = Number(checked.value);
  options.replaceChildren();
  if (!q) return;
  if (s.hasAnswered) serverAnsweredQuestionId = q.id;
  const saved = !!localStorage.getItem(`live-poll-vote-${q.id}`) || serverAnsweredQuestionId === q.id;
  if (saved) { submitted = true; selectedOptionIndex = null; }
  const locked = saved || submitted || submitting;
  if (q.type === 'registration') renderRegistrationForm(q, options, locked);
  else q.options.forEach((label, index) => {
      const row = document.createElement('label'); row.className = 'option';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'answer'; input.value = String(index); input.disabled = locked;
      input.checked = !locked && selectedOptionIndex === index;
      const text = document.createElement('span'); text.textContent = label;
      row.append(input, text); options.append(row);
    });
  $('submit').disabled = locked;
  $('submit').textContent = submitting ? 'جارٍ الإرسال…' : locked ? 'تم تسجيل الإجابة' : 'إرسال الإجابة';
  $('message').textContent = saved ? 'Thanks for participating, your answer has been recorded.' : '';
}
async function initialize() {
  try {
    const url = questionId ? `/api/state?questionId=${encodeURIComponent(questionId)}` : '/api/state';
    const response = await fetch(url); const initial = await response.json();
    if (!initial.question) throw new Error('Question not found.');
    questionId = initial.question.id;
    const pageUrl = new URL(location.href); pageUrl.searchParams.set('questionId', questionId); history.replaceState({}, '', pageUrl);
    render(initial);
    socket = io({ query: { questionId } }); socket.on('state', render);
  } catch (error) { $('question').textContent = error.message || 'Could not connect. Please refresh.'; }
}
initialize();
$('answer-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!state?.question || submitting || submitted) return;
  const isRegistration = state.question.type === 'registration';
  const choice = document.querySelector('input[name="answer"]:checked');
  const optionIndex = choice ? Number(choice.value) : selectedOptionIndex;
  if (!isRegistration && !Number.isInteger(optionIndex)) { $('message').textContent = 'Choose an answer.'; return; }
  const submittedQuestionId = state.question.id;
  const payload = isRegistration ? {
    name: $('form-name').value,
    surname: $('form-surname').value,
    phone: $('form-phone').value,
    email: $('form-email').value,
    certificate: document.querySelector('input[name="certificate"]:checked')?.value,
    topic: document.querySelector('input[name="form-topic"]:checked')?.value,
    topicOther: $('form-topicOther').value
  } : { questionId: submittedQuestionId, optionIndex };
  submitting = true;
  render(state);
  try {
    const response = await fetch(isRegistration ? '/api/form-submission' : '/api/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 && (body.error?.includes('already answered') || body.error?.includes('already submitted'))) {
        serverAnsweredQuestionId = submittedQuestionId;
        localStorage.setItem(`live-poll-vote-${submittedQuestionId}`, 'yes');
        submitting = false; submitted = true;
        render(state);
        showThankYou();
        return;
      }
      throw new Error(body.error || 'Could not submit your answer.');
    }
    localStorage.setItem(`live-poll-vote-${submittedQuestionId}`, 'yes');
    submitting = false; submitted = true; selectedOptionIndex = null;
    serverAnsweredQuestionId = submittedQuestionId;
    render({ ...state, hasAnswered: true }); showThankYou();
  } catch (error) {
    // The server may have saved the vote even if the response was interrupted.
    // Check the persisted answer before asking the respondent to submit again.
    try {
      const verificationResponse = await fetch(`/api/state?questionId=${encodeURIComponent(submittedQuestionId)}`, { cache: 'no-store' });
      const verification = await verificationResponse.json();
      if (verificationResponse.ok && verification.hasAnswered) {
        localStorage.setItem(`live-poll-vote-${submittedQuestionId}`, 'yes');
        serverAnsweredQuestionId = submittedQuestionId;
        submitting = false; submitted = true; selectedOptionIndex = null;
        render({ ...verification, hasAnswered: true });
        showThankYou();
        return;
      }
    } catch (_) { /* Show the original error if confirmation is unavailable. */ }
    submitting = false;
    $('message').textContent = error.message;
    render(state);
  }
});
