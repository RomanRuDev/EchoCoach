const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, safeStorage, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODELS_URL = 'https://api.groq.com/openai/v1/models';
const LANG_NAMES = { auto: 'automático', en: 'inglés', es: 'español', fr: 'francés', de: 'alemán', pt: 'portugués', it: 'italiano' };
let win;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Clave guardada por el usuario: cifrada con el almacén del sistema (DPAPI en Windows).
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

function writeSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s));
}

function storedKey() {
  const { apiKey, encrypted } = readSettings();
  if (!apiKey) return null;
  try {
    return encrypted ? safeStorage.decryptString(Buffer.from(apiKey, 'base64')) : apiKey;
  } catch { return null; }
}

function saveKey(key) {
  const s = readSettings();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('El almacén seguro del sistema no está disponible. Configura GROQ_API_KEY en el entorno.');
  }
  s.apiKey = safeStorage.encryptString(key).toString('base64');
  s.encrypted = true;
  writeSettings(s);
}

function clearKey() {
  const s = readSettings();
  delete s.apiKey; delete s.encrypted;
  writeSettings(s);
}

// Orden: clave guardada en la app, variable de entorno GROQ_API_KEY, o .env (solo desarrollo).
function getApiKey() {
  const stored = storedKey();
  if (stored) return stored;
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  for (const dir of [app.getAppPath(), app.getPath('userData')]) {
    try {
      const m = fs.readFileSync(path.join(dir, '.env'), 'utf8').match(/^\s*GROQ_API_KEY\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch {}
  }
  return null;
}

function keySource() {
  if (storedKey()) return 'app';
  return getApiKey() ? 'env' : 'none';
}

function toWav(float32) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

async function transcribe({ audio, language, model }) {
  const key = getApiKey();
  if (!key) throw new Error('Falta la clave de Groq: configúrala en el engranaje');
  const form = new FormData();
  form.append('file', new Blob([toWav(new Float32Array(audio))], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language && language !== 'auto' && LANG_NAMES[language]) form.append('language', language);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 2;
      log(`groq 429, retry in ${wait}s`);
      send('status', { text: `Límite de Groq alcanzado, reintentando en ${wait}s...` });
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return cleanTranscript(await res.json());
  }
  throw new Error('Groq: demasiadas solicitudes (429)');
}

// Descarta segmentos que Whisper inventa con música, notificaciones u otros sonidos que no son voz.
function cleanTranscript(json) {
  const segs = Array.isArray(json.segments) ? json.segments : null;
  if (!segs) return (json.text || '').trim();
  const kept = segs.filter((s) => !(s.no_speech_prob > 0.5 || s.avg_logprob < -1 || s.compression_ratio > 2.4 || (s.no_speech_prob > 0.3 && s.avg_logprob < -0.7)));
  if (kept.length < segs.length) log(`dropped ${segs.length - kept.length}/${segs.length} non-speech segments`);
  return kept.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

// Captura de salida por dispositivo (WASAPI loopback) con un ayudante nativo.
const { spawn } = require('child_process');
const helperPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'EchoLoopback.exe') : path.join(__dirname, 'native', 'EchoLoopback.exe'));
let loopback = null;

function listOutputs() {
  return new Promise((resolve) => {
    if (!fs.existsSync(helperPath())) return resolve({ ok: false, outputs: [] });
    const p = spawn(helperPath(), ['list'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ ok: false, outputs: [] }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, outputs: [] });
      const outputs = out.split('\n').filter(Boolean).map((l) => {
        const [id, name, def] = l.replace(/\r$/, '').split('\t');
        return { id, name, isDefault: def === '1' };
      });
      resolve({ ok: true, outputs });
    });
  });
}

function stopLoopback() {
  const p = loopback;
  loopback = null;
  if (!p) return;
  p.removeAllListeners('close');
  try { p.stdin.end(); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
}

function startLoopback(id) {
  stopLoopback();
  return new Promise((resolve) => {
    if (!fs.existsSync(helperPath())) return resolve({ ok: false, error: 'Falta EchoLoopback.exe (ejecuta npm run build:native).' });
    const p = spawn(helperPath(), ['capture', String(id || 'default')], { windowsHide: true });
    loopback = p;
    let started = false;
    let err = '';
    let rest = Buffer.alloc(0);
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (chunk) => {
      if (!started) { started = true; resolve({ ok: true }); }
      const buf = Buffer.concat([rest, chunk]);
      const usable = buf.length - (buf.length % 4);
      rest = buf.subarray(usable);
      if (usable) send('loopback-audio', Uint8Array.from(buf.subarray(0, usable)));
    });
    p.on('error', (e) => { if (!started) resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      if (loopback === p) loopback = null;
      const message = err.trim() || `El capturador de audio se cerró (código ${code}).`;
      log(`loopback closed: ${message}`);
      if (!started) resolve({ ok: false, error: message });
      else send('loopback-ended', { message });
    });
  });
}

// Conversaciones guardadas: un archivo JSON por conversación.
const convDir = () => {
  const dir = path.join(app.getPath('userData'), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const convFile = (id) => {
  if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error('Id de conversación no válido');
  return path.join(convDir(), `${id}.json`);
};

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CHAT_MODEL = 'openai/gpt-oss-120b';
const CODE_MODEL = 'openai/gpt-oss-120b';
const chatModel = () => readSettings().model || CHAT_MODEL;
const codeModel = () => readSettings().codeModel || CODE_MODEL;
// Preguntas técnicas/de programación usan el LLM de programación.
const CODING_QUESTION = /\b(c[oó]digo|code|program\w*|script|funci[oó]n|function|algoritm\w*|algorithm|bug|error|stack ?trace|compil\w*|debug\w*|refactor\w*|query|sql|api|regex|clase|class|array|arreglo|loop|bucle|promise|async|await|node|npm|javascript|typescript|python|java|c#|react|git|docker|comando|command|terminal|implement\w*|escrib\w+ (un|el|la)|write (a|the)|reto|challenge|test)\b/i;
const modelFor = (question) => (CODING_QUESTION.test(question) ? codeModel() : chatModel());
const supportsReasoningEffort = (m) => /gpt-oss/.test(m);
// Modelos con mejor desempeño en código, para mostrarlos primero.
const CODING_HINT = /coder|code|gpt-oss|qwen|kimi|deepseek|devstral/i;
const NON_CHAT = /whisper|orpheus|tts|guard|embed|prompt-guard|safeguard/i;
let suggestAbort = null;
let suggestTurn = null;

function log(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// Currículum en PDF elegido por el usuario: se extrae el texto y se limita su tamaño.
let cvText = '';
const MAX_CV_CHARS = 12000;

async function readPdf(file) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    const r = await parser.getText();
    return r.text.replace(/\n-- \d+ of \d+ --\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CV_CHARS);
  } finally {
    await parser.destroy();
  }
}

// Capturas e imágenes: se reducen y comprimen para respetar los límites de Groq.
const VISION_MODEL = 'qwen/qwen3.8-27b';
const MAX_IMAGES = 4;
const MAX_IMAGE_WIDTH = 1600;

async function captureScreen() {
  const point = win && !win.isDestroyed() ? screen.getCursorScreenPoint() : screen.getPrimaryDisplay().bounds;
  const display = screen.getDisplayNearestPoint(point);
  const wasVisible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  // Se oculta la ventana para capturar lo que hay detrás (editor, enunciado, consola).
  if (wasVisible) { win.hide(); await new Promise((r) => setTimeout(r, 350)); }
  try {
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src) throw new Error('No se encontró ninguna pantalla para capturar.');
    let img = src.thumbnail;
    if (img.getSize().width > MAX_IMAGE_WIDTH) img = img.resize({ width: MAX_IMAGE_WIDTH, quality: 'best' });
    return `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } finally {
    if (wasVisible) { win.show(); win.focus(); }
  }
}

async function suggest({ id, turn, history = [], question, images = [], interviewLang = 'auto', mainLang = 'es' }) {
  const key = getApiKey();
  if (!key) {
    const message = 'Falta la clave de Groq: configúrala en el engranaje';
    send('status', { text: message });
    send('suggestion-error', { id, message });
    return;
  }
  images = images.filter((u) => /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, MAX_IMAGES);
  // Solo se cancela la petición previa del mismo turno (pregunta que sigue creciendo).
  if (suggestTurn === turn) suggestAbort?.abort();
  suggestTurn = turn;
  const ctrl = (suggestAbort = new AbortController());
  const iName = LANG_NAMES[interviewLang] || 'automático';
  const mName = LANG_NAMES[mainLang] && mainLang !== 'auto' ? LANG_NAMES[mainLang] : 'español';
  const interviewRule = interviewLang === 'auto'
    ? 'El idioma de la entrevista es el idioma en que está escrito el último mensaje del entrevistador.'
    : `El idioma de la entrevista es ${iName}; úsalo para lo que el usuario dirá, aunque el mensaje llegue con errores de transcripción en otro idioma.`;
  const system =
    'Eres un coach de práctica para entrevistas técnicas: el usuario se prueba a sí mismo y compara sus respuestas con las tuyas. Cada mensaje del usuario es lo que dice el entrevistador o una petición del usuario (a veces es una transcripción automática con errores). ' +
    'Tus mensajes anteriores son respuestas que ya diste; mantén coherencia y no repitas lo ya dicho. Responde SOLO al último mensaje. ' +
    'Estilo: escribe como habla una persona de verdad, no como una IA. Frases cortas y directas, tono natural, en primera persona. Máximo 2-3 frases por respuesta hablada: ve al grano, sin introducciones, sin rodeos, sin frases hechas ("es importante destacar", "en resumen", "cabe mencionar", "excelente pregunta"), sin enumerar definiciones ni sonar a manual. Usa contracciones y giros cotidianos del idioma, y un ejemplo breve de su experiencia solo si está en su currículum. Usa los términos técnicos correctos y escribe los nombres completos, sin abreviar (por ejemplo "JavaScript", no "JS"; "base de datos", no "BD"). Sin relleno, sin saludos ni despedidas, sin emojis. Markdown mínimo:\n' +
    '- Pregunta conceptual: una línea "**Di:**" con 2-3 frases habladas, qué es y para qué sirve o un ejemplo corto. Solo si aporta, una viñeta "**Si profundizan:**" con un punto técnico extra.\n' +
    '- Reto técnico o petición de código (por ejemplo "escribe una función que...", "abre el editor y haz..."): responde con estas secciones, en este orden:\n' +
    '  1. "**Di:**" lo que el usuario puede decir en voz alta para mostrar que entendió el reto y cuál es su plan, en 1-2 frases naturales.\n' +
    '  2. "**Tu tarea:**" explica en una frase qué debe lograr y con qué entradas y salidas.\n' +
    '  3. "**Paso a paso:**" pasos numerados; cada paso es UNA acción concreta que el usuario hace a mano: indica exactamente qué archivo crear o abrir y qué escribir en él y por qué, y cada comando de terminal en su propio bloque de código (uno por comando, exacto, indicando en qué carpeta ejecutarlo). Tras cada comando di brevemente qué hace y qué debería ver. NO repitas el código completo dentro de los pasos: en el paso de escribirlo, explica sus partes en orden (qué va primero, qué después) y remite a "Código completo".\n' +
    '  4. "**Código completo:**" el código final correcto, completo y ejecutable en un bloque ```lenguaje (sin placeholders; comentarios breves en español solo donde aclaren una decisión).\n' +
    '  5. "**Salida esperada:**" lo que imprime EXACTAMENTE, con el formato real del lenguaje (por ejemplo console.log de un arreglo en Node.js imprime [ 1, 2, 3 ]).\n' +
    '  6. "**Qué decir mientras lo escribes:**" 1-2 frases cortas y naturales para narrar las decisiones clave mientras programa.\n' +
    'Si el usuario pide solo cómo ejecutarlo o un paso concreto, responde solo eso, sin repetir lo anterior. ' +
    'Verifica paso a paso que el código funciona y que la salida esperada es exacta; usa ejemplos con salida DETERMINISTA (evita carreras entre timers, setImmediate e I/O) y, si el orden pudiera variar, dilo. ' +
    `Idiomas. ${interviewRule} El idioma principal del usuario es ${mName}. Regla: (1) todo lo que el usuario deba DECIR en voz alta a otras personas (bloques "Di", frases para narrar, y cualquier comentario o nombre de variable sugerido en voz alta) va en el idioma de la entrevista; (2) todo lo que es para el propio usuario (títulos de sección, "Tu tarea", explicaciones, pasos, notas) va en ${mName}, y escribe los títulos de sección traducidos a ${mName} (por ejemplo "Di"→"Say" si ${mName} es inglés); (3) si el idioma de la entrevista es distinto de ${mName}, justo debajo de cada bloque "Di" y de cada frase para narrar añade una línea en cursiva "**Significa:**" (traducida a ${mName}) con su traducción a ${mName}; si son el mismo idioma, no añadas traducción. El código, los comandos y los nombres técnicos no se traducen. ` +
    'Saludos, presentaciones, cortesías, agradecimientos, small talk ("encantada de conocerte", "gracias por venir", "¿cómo estás?") y comentarios amables SÍ requieren respuesta: da una "**Di:**" de una sola frase corta, cálida y natural, como lo diría una persona, que devuelva la cortesía; si el entrevistador se presenta, usa su nombre y, si el currículum del usuario tiene su nombre, preséntate con él. No inventes datos personales. ' +
    'Responde exactamente [SIN_PREGUNTA] si el mensaje es ruido, una muletilla suelta, un fragmento sin significado ("mm", "ajá", "okay" a solas), o texto que claramente no viene de una entrevista (letras de canciones, anuncios, subtítulos, créditos, frases sueltas de vídeos o apps). ' +
    'Si el mensaje trae imágenes, son capturas de pantalla o fotos del usuario (enunciados, código, errores, diagramas): léelas con cuidado, transcribe lo relevante y úsalas como contexto principal para responder; si pide cómo resolver o ejecutar algo, sigue el formato de reto técnico. ' +
    'No expliques tu razonamiento.' +
    (cvText ? `\nCurrículum del usuario (úsalo para personalizar las respuestas con su experiencia real, sin inventar datos que no estén aquí):\n${cvText}` : '\nNo hay currículum cargado: no inventes empresas, años, cifras ni logros del usuario; usa respuestas generales o marcadores entre corchetes como [tu experiencia] donde haría falta un dato personal.');
  const userContent = images.length
    ? [{ type: 'text', text: question }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : question;
  const useModel = images.length ? VISION_MODEL : modelFor(question);
  const payload = {
    model: useModel,
    stream: true,
    temperature: 0.4,
    max_tokens: 1500,
    ...(supportsReasoningEffort(useModel) ? { reasoning_effort: 'medium' } : {}),
    messages: [
      { role: 'system', content: system },
      ...history.flatMap((h) => [
        { role: 'user', content: h.q },
        ...(h.a ? [{ role: 'assistant', content: h.a }] : []),
      ]),
      { role: 'user', content: userContent },
    ],
  };
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (images.length && /blocked at the project level|does not exist or you do not have access/.test(body)) {
        throw new Error(`El modelo de visión (${VISION_MODEL}) no está habilitado en tu proyecto de Groq. Actívalo en console.groq.com/settings/project/limits y vuelve a intentarlo.`);
      }
      throw new Error(`Groq chat ${res.status}: ${body}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { send('suggestion-done', { id }); return; }
        try {
          const text = JSON.parse(data).choices?.[0]?.delta?.content;
          if (text) send('suggestion-chunk', { id, text });
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      log(`suggest error: ${err.message || err}`);
      send('status', { text: String(err.message || err) });
      send('suggestion-error', { id, message: String(err.message || err) });
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 650,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Captura el audio de salida del sistema (loopback) sin pedir ventana/pantalla.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});
    }
  });

  ipcMain.handle('load-model', async () => {
    if (getApiKey()) return { ok: true };
    send('status', { text: 'Falta la clave de Groq: configúrala en el engranaje' });
    return { ok: false, needKey: true };
  });

  ipcMain.handle('get-settings', () => ({ keySource: keySource(), encrypted: safeStorage.isEncryptionAvailable(), model: chatModel(), codeModel: codeModel() }));

  ipcMain.handle('list-models', async () => {
    const key = getApiKey();
    const current = { current: chatModel(), currentCode: codeModel() };
    if (!key) return { ok: false, models: [], ...current };
    try {
      const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) return { ok: false, models: [], ...current };
      const ids = (await res.json()).data.map((m) => m.id).filter((id) => !NON_CHAT.test(id)).sort();
      return { ok: true, models: ids.map((id) => ({ id, coding: CODING_HINT.test(id) })), ...current };
    } catch {
      return { ok: false, models: [], ...current };
    }
  });

  ipcMain.handle('set-model', (_e, kind, id) => {
    const field = kind === 'code' ? 'codeModel' : 'model';
    const s = readSettings();
    s[field] = String(id || '');
    if (!s[field]) delete s[field];
    writeSettings(s);
    log(`${field}: ${s[field] || 'default'}`);
    return true;
  });

  // Valida la clave contra Groq antes de guardarla.
  ipcMain.handle('save-key', async (_e, raw) => {
    const key = String(raw || '').trim();
    if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) return { ok: false, error: 'La clave debe empezar con "gsk_".' };
    try {
      const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 401) return { ok: false, error: 'Groq rechazó la clave (no válida).' };
      if (!res.ok) return { ok: false, error: `No se pudo validar la clave (Groq ${res.status}).` };
    } catch {
      return { ok: false, error: 'Sin conexión: no se pudo validar la clave.' };
    }
    saveKey(key);
    log('api key saved');
    return { ok: true, keySource: keySource() };
  });

  ipcMain.handle('clear-key', () => { clearKey(); log('api key cleared'); return { keySource: keySource() }; });

  ipcMain.handle('transcribe', async (_e, args) => {
    const t0 = Date.now();
    try {
      const text = await transcribe(args);
      log(`transcribe ok ${Date.now() - t0}ms: ${text.slice(0, 80)}`);
      return text;
    } catch (err) {
      log(`transcribe error: ${err.message || err}`);
      send('status', { text: String(err.message || err) });
      return '';
    }
  });

  ipcMain.handle('suggest', (_e, args) => {
    log(`suggest turn=${args.turn} images=${(args.images || []).length} q=${String(args.question).slice(0, 80)}`);
    suggest(args);
  });

  ipcMain.handle('conv-list', () => {
    const out = [];
    for (const f of fs.readdirSync(convDir())) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(convDir(), f), 'utf8'));
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: (c.turns || []).length });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle('conv-load', (_e, id) => {
    try { return JSON.parse(fs.readFileSync(convFile(id), 'utf8')); } catch { return null; }
  });

  ipcMain.handle('conv-save', (_e, conv) => {
    const turns = (Array.isArray(conv.turns) ? conv.turns : []).map((t) => ({
      text: String(t.text || ''), answer: String(t.answer || ''), manual: !!t.manual, images: Number(t.images) || 0,
    }));
    const file = convFile(conv.id);
    let createdAt = Date.now();
    try { createdAt = JSON.parse(fs.readFileSync(file, 'utf8')).createdAt || createdAt; } catch {}
    const first = turns.find((t) => t.text)?.text || 'Conversación';
    const title = first.length > 60 ? `${first.slice(0, 60)}…` : first;
    fs.writeFileSync(file, JSON.stringify({ id: conv.id, title, createdAt, updatedAt: Date.now(), turns }));
    return true;
  });

  ipcMain.handle('conv-delete', (_e, id) => {
    try { fs.unlinkSync(convFile(id)); } catch {}
    return true;
  });

  ipcMain.handle('list-outputs', () => listOutputs());
  ipcMain.handle('loopback-start', (_e, id) => startLoopback(id));
  ipcMain.handle('loopback-stop', () => { stopLoopback(); return true; });

  ipcMain.handle('capture-screen', async () => {
    try {
      const dataUrl = await captureScreen();
      log(`screenshot captured (${Math.round(dataUrl.length / 1024)} KB)`);
      return { ok: true, dataUrl };
    } catch (err) {
      log(`screenshot error: ${err.message || err}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('pick-cv', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return { name: cvText ? 'cargado' : '' };
    try {
      cvText = await readPdf(r.filePaths[0]);
      if (!cvText) throw new Error('El PDF no tiene texto seleccionable (¿es una imagen escaneada?)');
      log(`cv loaded: ${path.basename(r.filePaths[0])} (${cvText.length} chars)`);
      return { name: path.basename(r.filePaths[0]) };
    } catch (err) {
      cvText = '';
      log(`cv error: ${err.message || err}`);
      return { name: '', error: String(err.message || err) };
    }
  });

  ipcMain.handle('clear-cv', () => { cvText = ''; return ''; });

  createWindow();
});

app.on('before-quit', stopLoopback);
app.on('window-all-closed', () => app.quit());
