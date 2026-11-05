const $ = (id) => document.getElementById(id);
const SAMPLE_RATE = 16000;
const PAUSE_MS = 500;         // silencio que cierra una frase
const MAX_UTTERANCE_S = 15;   // corte forzado si alguien habla sin pausa
const PREROLL_MS = 300;       // audio previo para no cortar el inicio de la palabra
const MIN_SPEECH_MS = 400;    // ignora ruidos breves (notificaciones, clics)
const MIN_VOICED_RATIO = 0.35; // la frase debe ser sobre todo voz, no un golpe suelto
const MIN_LEVEL_VARIATION = 0.2; // la voz varía de volumen; un tono o zumbido constante no
const TURN_GAP_MS = 5000;     // pausa de audio que separa una pregunta de la siguiente
const SUGGEST_DELAY_MS = 1200; // espera a ver si la pregunta continúa antes de responder
const HISTORY_TURNS = 10;     // turnos previos enviados como contexto
const NO_QUESTION = '[SIN_PREGUNTA]';

let ctx = null;
let stream = null;
let node = null;
let running = false;

let noiseFloor = 0.003;
let speaking = false;
let utter = [];
let preroll = [];
let utterSamples = 0;
let speechSamples = 0;
let silenceSamples = 0;
let levelSum = 0;
let levelSq = 0;
let levelN = 0;
let finalChain = Promise.resolve();

const turns = [];
let lastSpeechEndAt = 0;
let pendingTranscriptions = 0;
let reqSeq = 0;

window.api.onStatus((s) => { $('status').textContent = s.text; });

function rms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function concat(chunks, total) {
  const audio = new Float32Array(total);
  let o = 0;
  for (const b of chunks) { audio.set(b, o); o += b.length; }
  return audio;
}

// Whisper emite textos entre corchetes/paréntesis, o "you", con ruido o silencio.
const HALLUCINATIONS = /subt[ií]tulos|subtitles? by|amara\.org|suscr[ií]be|thanks? for watching|gracias por ver|mbc|www\.|©|^(music|m[uú]sica|applause|aplausos)\b/i;
const isNoise = (t) => !t || /^\[.*\]$|^\(.*\)$/.test(t) || /^(you|thanks for watching[.!]?)$/i.test(t.trim().replace(/[.!]$/, '')) || HALLUCINATIONS.test(t) || !/[\p{L}\p{N}]/u.test(t);

function makeCard(extraClass, tag) {
  const card = document.createElement('div');
  card.className = 'card ' + extraClass;
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  const body = document.createElement('span');
  body.className = 'body';
  card.append(t, body);
  return { card, body };
}

// Markdown mínimo sin innerHTML: bloques ```código```, **negrita**, `código`, listas.
function inline(parent, text) {
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach((part) => {
    if (!part) return;
    let el;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) { el = document.createElement('strong'); el.textContent = part.slice(2, -2); }
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) { el = document.createElement('code'); el.textContent = part.slice(1, -1); }
    else el = document.createTextNode(part);
    parent.append(el);
  });
}

function renderMarkdown(container, md) {
  container.replaceChildren();
  const segments = md.split('```');
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      const nl = seg.indexOf('\n');
      const lang = nl === -1 ? '' : seg.slice(0, nl).trim();
      const raw = (nl === -1 ? seg : seg.slice(nl + 1)).replace(/\n[ \t]*$/, '');
      const codeLines = raw.split('\n');
      const lead = (l) => l.match(/^[ \t]*/)[0].length;
      // Quita la sangría común (los bloques dentro de listas vienen indentados).
      const indent = Math.min(...codeLines.filter((l) => l.trim()).map(lead), 1e9);
      const text = indent < 1e9 ? codeLines.map((l) => l.slice(Math.min(indent, lead(l)))).join('\n') : raw;
      const wrap = document.createElement('div');
      wrap.className = 'codeblock';
      if (lang) {
        const l = document.createElement('div');
        l.className = 'lang';
        l.textContent = lang;
        wrap.append(l);
      }
      const pre = document.createElement('pre');
      pre.textContent = text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy';
      btn.textContent = 'Copiar';
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        await navigator.clipboard.writeText(text);
        btn.textContent = '¡Copiado!';
        setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
      };
      wrap.append(btn, pre);
      container.append(wrap);
      return;
    }
    seg.split('\n').forEach((line) => {
      if (!line.trim()) return;
      const p = document.createElement('div');
      p.className = /^\s*([-*•]|\d+\.)\s/.test(line) ? 'line item' : 'line';
      inline(p, line.replace(/^(\s*)[-*]\s/, '$1• ').trim());
      container.append(p);
    });
  });
}

function scrollBottom(list) {
  list.scrollTop = list.scrollHeight;
}

function setCollapsed(turn, collapsed) {
  turn.qCard.classList.toggle('collapsed', collapsed);
  turn.aCard.classList.toggle('collapsed', collapsed);
}

function newTurn(manual = false) {
  const n = turns.length + 1;
  const q = makeCard('question', manual ? `Tu pregunta ${n}` : `Pregunta ${n}`);
  const a = makeCard('answer pending', `Respuesta ${n}`);
  a.body.textContent = 'Esperando...';
  const turn = { n, manual, text: '', answer: '', reqId: 0, timer: null, qCard: q.card, qBody: q.body, aCard: a.card, aBody: a.body };
  // No alterna si el clic fue al terminar de seleccionar texto, y las tarjetas abiertas solo se cierran con el encabezado.
  const toggle = (ev) => {
    if (String(window.getSelection())) return;
    const collapsed = turn.qCard.classList.contains('collapsed');
    if (!collapsed && !ev.target.classList.contains('tag')) return;
    setCollapsed(turn, !collapsed);
  };
  q.card.onclick = toggle;
  a.card.onclick = toggle;
  // Las anteriores se minimizan; el contexto sigue yendo al modelo.
  turns.forEach((t) => setCollapsed(t, true));
  $('transcriptList').append(q.card);
  $('answerList').append(a.card);
  turns.push(turn);
  return turn;
}

// startAt/endAt son los tiempos reales del audio, no del momento en que llega la transcripción.
function addPhrase(text, startAt, endAt) {
  let turn = turns[turns.length - 1];
  if (!turn || turn.manual || startAt - lastSpeechEndAt > TURN_GAP_MS) turn = newTurn();
  lastSpeechEndAt = endAt;
  turn.text += (turn.text ? ' ' : '') + text;
  turn.qBody.textContent = turn.text;
  scrollBottom($('transcriptList'));
  scheduleSuggestion(turn);
}

function addManualQuestion(text, images = []) {
  const turn = newTurn(true);
  turn.text = text;
  turn.images = images;
  turn.qBody.textContent = text;
  if (images.length) {
    const shots = document.createElement('div');
    shots.className = 'shots';
    images.forEach((u) => { const im = document.createElement('img'); im.src = u; shots.append(im); });
    turn.qBody.append(shots);
  }
  scrollBottom($('transcriptList'));
  scheduleSuggestion(turn, 0);
}

function scheduleSuggestion(turn, delay = SUGGEST_DELAY_MS) {
  clearTimeout(turn.timer);
  turn.scheduled = true;
  turn.timer = setTimeout(() => {
    // Si aún se está hablando o transcribiendo, la pregunta puede no estar completa.
    if (!turn.manual && (speaking || pendingTranscriptions > 0)) return scheduleSuggestion(turn, 500);
    turn.scheduled = false;
    const reqId = ++reqSeq;
    turn.reqId = reqId;
    turn.answer = '';
    turn.aCard.classList.remove('none');
    turn.aCard.classList.remove('error');
    turn.aCard.classList.add('pending');
    turn.aBody.textContent = 'Pensando...';
    const history = turns
      .slice(0, turns.indexOf(turn))
      .slice(-HISTORY_TURNS)
      .map((t) => ({ q: t.images && t.images.length ? `${t.text} [con ${t.images.length} imagen(es) adjunta(s)]` : t.text, a: t.answer && !t.answer.startsWith(NO_QUESTION) ? t.answer : '' }));
    window.api.suggest({ id: reqId, turn: turn.n, history, question: turn.text, images: turn.images || [], interviewLang: $('interviewleng').value, mainLang: $('mainleng').value });
  }, delay);
}

window.api.onSuggestionChunk(({ id, text }) => {
  const turn = turns.find((t) => t.reqId === id);
  if (!turn) return;
  turn.answer += text;
  const head = turn.answer.trimStart();
  if (NO_QUESTION.startsWith(head.slice(0, NO_QUESTION.length))) return;
  turn.aCard.classList.remove('pending');
  renderMarkdown(turn.aBody, turn.answer);
  scrollBottom($('answerList'));
});

window.api.onSuggestionDone(({ id }) => {
  const turn = turns.find((t) => t.reqId === id);
  if (!turn) return;
  if (!turn.answer.trim() || turn.answer.trimStart().startsWith(NO_QUESTION)) {
    turn.answer = NO_QUESTION;
    turn.aCard.classList.remove('pending');
    turn.aCard.classList.add('none');
    turn.aBody.textContent = 'Sin pregunta detectada';
  }
  saveConversation();
});

function looksLikeSpeech() {
  const spoken = utterSamples - silenceSamples;
  if (spoken <= 0 || speechSamples / spoken < MIN_VOICED_RATIO) return false;
  if (levelN < 10) return false;
  const mean = levelSum / levelN;
  const sd = Math.sqrt(Math.max(0, levelSq / levelN - mean * mean));
  return mean > 0 && sd / mean >= MIN_LEVEL_VARIATION;
}

function finalizeUtterance() {
  const enough = speechSamples >= (MIN_SPEECH_MS / 1000) * SAMPLE_RATE && looksLikeSpeech();
  const audio = enough ? concat(utter, utterSamples) : null;
  const endAt = Date.now() - (silenceSamples / SAMPLE_RATE) * 1000;
  const startAt = endAt - (speechSamples / SAMPLE_RATE) * 1000;
  utter = []; utterSamples = 0; speechSamples = 0; silenceSamples = 0;
  levelSum = levelSq = levelN = 0;
  speaking = false;
  if (!audio) return;
  const language = $('interviewleng').value;
  const model = $('model').value;
  pendingTranscriptions++;
  finalChain = finalChain.then(async () => {
    try {
      const text = await window.api.transcribe(audio, language, model);
      if (!isNoise(text)) addPhrase(text, startAt, endAt);
    } finally {
      pendingTranscriptions--;
    }
  });
}

function onAudio(data) {
  const level = rms(data);
  $('level').style.width = Math.min(100, level * 400) + '%';
  const threshold = Math.max(0.012, noiseFloor * 4);
  const voiced = level > threshold;
  if (!voiced) noiseFloor = noiseFloor * 0.98 + level * 0.02;

  if (!speaking) {
    preroll.push(data);
    const max = Math.ceil((PREROLL_MS / 1000) * SAMPLE_RATE / data.length);
    if (preroll.length > max) preroll.shift();
    if (!voiced) return;
    speaking = true;
    utter = preroll;
    utterSamples = utter.reduce((n, c) => n + c.length, 0);
    preroll = [];
  } else {
    utter.push(data);
    utterSamples += data.length;
  }

  if (voiced) { speechSamples += data.length; silenceSamples = 0; levelSum += level; levelSq += level * level; levelN++; }
  else silenceSamples += data.length;

  if (silenceSamples >= (PAUSE_MS / 1000) * SAMPLE_RATE || utterSamples >= MAX_UTTERANCE_S * SAMPLE_RATE) {
    finalizeUtterance();
  }
}

async function start() {
  $('toggle').disabled = true;
  try {
    const res = await window.api.loadModel($('model').value);
    if (!res.ok) {
      if (res.needKey) openSettings('Ingresa tu API key de Groq para empezar.');
      return;
    }

    const source = $('audioSource').value;
    if (source.startsWith('out:')) {
      usingLoopback = true;
      const r = await window.api.startLoopback(source.slice(4));
      if (!r.ok) throw new Error(r.error);
    } else {
      if (source === 'system') {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach((t) => t.stop());
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: source.slice(3) }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      if (!stream.getAudioTracks().length) throw new Error('No se obtuvo pista de audio de la fuente elegida.');

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await ctx.audioWorklet.addModule('capture-worklet.js');
      node = new AudioWorkletNode(ctx, 'capture');
      node.port.onmessage = (e) => onAudio(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
    }

    running = true;
    $('toggle').textContent = 'Detener';
    $('toggle').classList.add('recording');
    $('status').textContent = 'Escuchando ' + $('audioSource').selectedOptions[0].textContent.replace(/ \(predeterminad[oa]\)$/, '') + '...';
  } catch (err) {
    let message = `No se pudo iniciar: ${err.message}`;
    if (usingLoopback) { usingLoopback = false; window.api.stopLoopback(); }
    node?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch (cleanupError) {
        message += `. También falló la limpieza: ${cleanupError.message}`;
      }
    }
    node = stream = ctx = null;
    $('status').textContent = message;
  } finally {
    $('toggle').disabled = false;
  }
}

// Audio de la salida elegida (ayudante nativo): llega en bloques que se reparten como los del worklet.
const LOOPBACK_CHUNK = 320;
let usingLoopback = false;
let loopbackPending = new Float32Array(0);

window.api.onLoopbackAudio((bytes) => {
  if (!usingLoopback) return;
  const n = bytes.byteLength >> 2;
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
  const all = new Float32Array(loopbackPending.length + n);
  all.set(loopbackPending);
  all.set(samples, loopbackPending.length);
  let o = 0;
  for (; o + LOOPBACK_CHUNK <= all.length; o += LOOPBACK_CHUNK) onAudio(all.slice(o, o + LOOPBACK_CHUNK));
  loopbackPending = all.slice(o);
});

window.api.onLoopbackEnded(({ message }) => {
  if (!usingLoopback) return;
  usingLoopback = false;
  $('status').textContent = `Se perdió la captura de audio: ${message}`;
  if (running) stop();
});

async function stop() {
  running = false;
  if (usingLoopback) { usingLoopback = false; loopbackPending = new Float32Array(0); await window.api.stopLoopback(); }
  node?.disconnect();
  stream?.getTracks().forEach((t) => t.stop());
  await ctx?.close();
  node = stream = ctx = null;
  if (speaking) finalizeUtterance();
  await finalChain;
  $('level').style.width = '0';
  $('toggle').textContent = 'Iniciar';
  $('toggle').classList.remove('recording');
  $('status').textContent = 'Guardando conversación...';
  await settleAnswers();
  await endConversation();
  $('status').textContent = 'Detenido. Conversación guardada.';
}

// Conversaciones: se guardan solas y al detener se limpia la pantalla para empezar otra.
let convId = null;

const snapshot = () => turns
  .filter((t) => t.text)
  .map((t) => ({ text: t.text, answer: t.answer && !t.answer.startsWith(NO_QUESTION) ? t.answer : '', manual: t.manual, images: (t.images || []).length }));

async function saveConversation() {
  const saved = snapshot();
  if (!saved.length) return;
  if (!convId) convId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try { await window.api.saveConversation({ id: convId, turns: saved }); } catch (err) { $('status').textContent = `No se pudo guardar: ${err.message}`; }
}

// Dispara las respuestas que aún esperan y espera (máx. 30 s) a que terminen.
async function settleAnswers() {
  turns.forEach((t) => { if (t.scheduled) scheduleSuggestion(t, 0); });
  const deadline = Date.now() + 30000;
  const busy = () => turns.some((t) => t.scheduled || t.aCard.classList.contains('pending'));
  while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

function clearConversation() {
  turns.forEach((t) => clearTimeout(t.timer));
  turns.length = 0;
  convId = null;
  lastSpeechEndAt = 0;
  $('transcriptList').replaceChildren();
  $('answerList').replaceChildren();
}

async function endConversation() {
  await saveConversation();
  clearConversation();
}

async function openConversation(id) {
  const conv = await window.api.loadConversation(id);
  if (!conv) return;
  await settleAnswers();
  await endConversation();
  convId = conv.id;
  conv.turns.forEach((s) => {
    const turn = newTurn(s.manual);
    turn.text = s.text;
    turn.answer = s.answer;
    turn.images = [];
    turn.qBody.textContent = s.images ? `${s.text} [${s.images} imagen(es)]` : s.text;
    turn.aCard.classList.remove('pending');
    if (s.answer) renderMarkdown(turn.aBody, s.answer);
    else { turn.aCard.classList.add('none'); turn.aBody.textContent = 'Sin respuesta'; }
  });
  closeHistory();
  $('status').textContent = 'Conversación cargada. Puedes seguir preguntando.';
}

const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

async function renderHistory() {
  const list = $('historyList');
  list.replaceChildren();
  const items = await window.api.listConversations();
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Todavía no hay conversaciones guardadas.';
    list.append(e);
    return;
  }
  items.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'item';
    const info = document.createElement('div');
    info.className = 'info';
    const b = document.createElement('b');
    b.textContent = c.title;
    const s = document.createElement('small');
    s.textContent = `${fmtDate(c.updatedAt)} · ${c.count} turnos`;
    info.append(b, s);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Eliminar';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      await window.api.deleteConversation(c.id);
      if (c.id === convId) convId = null;
      renderHistory();
    };
    row.onclick = () => openConversation(c.id);
    row.append(info, del);
    list.append(row);
  });
}

function openHistory() { $('historyModal').hidden = false; renderHistory(); }
function closeHistory() { $('historyModal').hidden = true; }

$('openHistory').onclick = openHistory;
$('closeHistory').onclick = closeHistory;
$('historyModal').addEventListener('mousedown', (e) => { if (e.target === $('historyModal')) closeHistory(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('historyModal').hidden) closeHistory(); });

$('newConv').onclick = async () => {
  await settleAnswers();
  await endConversation();
  $('status').textContent = running ? 'Escuchando. Conversación nueva.' : 'Listo para una conversación nueva';
};

$('toggle').onclick = async () => {
  $('toggle').disabled = true;
  try { await (running ? stop() : start()); } finally { $('toggle').disabled = false; }
};

// Idiomas: se recuerdan entre sesiones.
for (const id of ['interviewleng', 'mainleng']) {
  const saved = localStorage.getItem(id);
  if (saved && [...$(id).options].some((o) => o.value === saved)) $(id).value = saved;
  $(id).addEventListener('change', () => localStorage.setItem(id, $(id).value));
}

const KEY_STATES = {
  app: 'Clave guardada en este equipo.',
  env: 'Usando la clave del entorno (GROQ_API_KEY o .env). Puedes guardar otra aquí.',
  none: 'Aún no hay clave configurada.',
};

function setMsg(text, ok = false) {
  $('settingsMsg').textContent = text || '';
  $('settingsMsg').classList.toggle('ok', ok);
}

async function refreshKeyState() {
  const s = await window.api.getSettings();
  $('keyState').textContent = KEY_STATES[s.keySource];
  $('removeKey').hidden = s.keySource !== 'app';
  // Con clave guardada se muestran puntos; la clave real nunca sale del proceso principal.
  $('apiKey').placeholder = s.keySource === 'none' ? 'gsk_...' : '•'.repeat(40);
}

async function loadModels() {
  const r = await window.api.listModels();
  const fill = (sel, current) => {
    sel.replaceChildren();
    const list = [...r.models];
    if (!list.some((m) => m.id === current)) list.unshift({ id: current, coding: false });
    const group = (label, items) => {
      if (!items.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      items.forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.id; g.append(o); });
      sel.append(g);
    };
    group('Recomendados para código', list.filter((m) => m.coding));
    group('Otros', list.filter((m) => !m.coding));
    sel.value = current;
  };
  fill($('chatModel'), r.current);
  fill($('codeModel'), r.currentCode);
}

$('chatModel').addEventListener('change', () => window.api.setModel('chat', $('chatModel').value));
$('codeModel').addEventListener('change', () => window.api.setModel('code', $('codeModel').value));

async function loadAudioSources() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  // Sin permiso de audio los nombres vienen vacíos; se pide una vez para verlos.
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {}
  }
  const sel = $('audioSource');
  const saved = localStorage.getItem('audioSource');
  const { ok, outputs } = await window.api.listOutputs();
  sel.replaceChildren();
  if (ok && outputs.length) {
    const def = outputs.find((o) => o.isDefault);
    sel.append(new Option(`Salida predeterminada${def ? `: ${def.name}` : ''}`, 'out:default'));
    outputs.forEach((o) => sel.append(new Option(`Salida: ${o.name}`, `out:${o.id}`)));
  } else {
    sel.append(new Option('Salida predeterminada del sistema', 'system'));
  }
  devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .forEach((d, i) => sel.append(new Option(`Entrada: ${d.label || `Dispositivo ${i + 1}`}`, `in:${d.deviceId}`)));
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : sel.options[0].value;
}

$('audioSource').addEventListener('change', () => localStorage.setItem('audioSource', $('audioSource').value));
loadAudioSources();

async function openSettings(msg = '') {
  $('apiKey').value = '';
  setMsg(msg);
  loadAudioSources();
  await refreshKeyState();
  $('settingsModal').hidden = false;
  $('apiKey').focus();
  loadModels();
}

const closeSettings = () => { $('settingsModal').hidden = true; };

$('openSettings').onclick = () => openSettings();
$('closeSettings').onclick = closeSettings;
$('settingsModal').addEventListener('mousedown', (e) => { if (e.target === $('settingsModal')) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings(); });

$('saveSettings').onclick = async () => {
  const key = $('apiKey').value.trim();
  if (!key) { closeSettings(); return; }
  $('saveSettings').disabled = true;
  setMsg('Validando clave...');
  try {
    const r = await window.api.saveKey(key);
    if (!r.ok) { setMsg(r.error); return; }
    $('apiKey').value = '';
    setMsg('Clave guardada.', true);
    await refreshKeyState();
    setTimeout(closeSettings, 700);
  } catch (err) {
    setMsg(`No se pudo guardar la clave: ${err.message}`);
  } finally {
    $('saveSettings').disabled = false;
  }
};

$('removeKey').onclick = async () => {
  await window.api.clearKey();
  setMsg('Clave eliminada.', true);
  await refreshKeyState();
};
$('showTranscript').onchange = (e) => { $('transcriptPane').hidden = !e.target.checked; };

$('askForm').onsubmit = (e) => {
  e.preventDefault();
  let text = $('askInput').value.trim();
  if (!text && !attachments.length) return;
  if (!text) text = 'Analiza esta imagen y dime qué hacer y qué decir.';
  $('askInput').value = '';
  const images = attachments;
  attachments = [];
  renderAttachments();
  addManualQuestion(text, images);
};

$('pickCv').onclick = async () => {
  if ($('cvName').textContent) {
    await window.api.clearCv();
    $('cvName').textContent = '';
    $('pickCv').textContent = 'Elegir currículum (PDF)';
    return;
  }
  const r = await window.api.pickCv();
  $('cvName').textContent = r.name;
  $('pickCv').textContent = r.name ? 'Quitar currículum' : 'Elegir currículum (PDF)';
  if (r.error) $('status').textContent = r.error;
};

const MAX_ATTACHMENTS = 4;
let attachments = [];

function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren();
  box.hidden = attachments.length === 0;
  attachments.forEach((url, i) => {
    const th = document.createElement('div');
    th.className = 'thumb';
    const img = document.createElement('img');
    img.src = url;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Quitar';
    rm.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    th.append(img, rm);
    box.append(th);
  });
}

function addImage(url) {
  if (attachments.length >= MAX_ATTACHMENTS) { $('status').textContent = `Máximo ${MAX_ATTACHMENTS} imágenes por mensaje.`; return; }
  attachments.push(url);
  renderAttachments();
}

$('shotBtn').onclick = async () => {
  const btn = $('shotBtn');
  btn.disabled = true;
  const r = await window.api.captureScreen();
  btn.disabled = false;
  if (r.ok) addImage(r.dataUrl); else $('status').textContent = r.error;
  $('askInput').focus();
};

function readImageFile(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => addImage(reader.result);
  reader.readAsDataURL(file);
}
$('askInput').addEventListener('paste', (e) => {
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) { e.preventDefault(); readImageFile(item.getAsFile()); }
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  [...e.dataTransfer.files].forEach(readImageFile);
});

window.api.onSuggestionError(({ id, message }) => {
  const turn = turns.find((t) => t.reqId === id);
  if (!turn) return;
  turn.answer = '';
  turn.aCard.classList.remove('pending');
  turn.aCard.classList.add('error');
  turn.aBody.textContent = message;
  saveConversation();
});
