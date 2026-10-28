const splash = document.getElementById('splash');
const chat = document.getElementById('chat');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');
const status = document.getElementById('status');
const fileInput = document.getElementById('file-input');
const filesBox = document.getElementById('files');
let attached = [];

function renderFiles() {
  filesBox.replaceChildren();
  filesBox.hidden = attached.length === 0;
  attached.forEach((file, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const name = document.createElement('span');
    name.textContent = file.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `Remover ${file.name}`);
    rm.addEventListener('click', () => {
      attached.splice(i, 1);
      renderFiles();
    });
    chip.append(name, rm);
    filesBox.appendChild(chip);
  });
}

document.getElementById('attach').addEventListener('click', () => fileInput.click());
// Ctrl+V com imagem na área de transferência vira anexo
document.addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  attached.push(...imgs.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `colada-${Date.now()}-${i}.png`, { type: f.type }))));
  renderFiles();
});
fileInput.addEventListener('change', () => {
  attached.push(...fileInput.files);
  fileInput.value = '';
  renderFiles();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const avatar = document.getElementById('avatar');
const warning = document.getElementById('warning');
const IDLE_ICON = 'icons/CapriIconIdleBlinking.gif';
const TALK_ICON = 'icons/CapriIconTalkingBlinking.gif';

function setTalking(on) {
  const src = on ? TALK_ICON : IDLE_ICON;
  if (avatar.getAttribute('src') !== src) avatar.setAttribute('src', src);
}

// markdown mínimo e seguro: só nós de texto, nunca innerHTML
function inline(parent, text) {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    const el = document.createElement(tok.startsWith('`') ? 'code' : tok.startsWith('**') ? 'strong' : 'em');
    el.textContent = tok.startsWith('**') ? tok.slice(2, -2) : tok.slice(1, -1);
    parent.appendChild(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(body, text) {
  body.replaceChildren();
  text.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/\n$/, '');
      pre.appendChild(code);
      body.appendChild(pre);
    } else if (part.trim()) {
      const p = document.createElement('p');
      inline(p, part.trim());
      body.appendChild(p);
    }
  });
}

const hhmm = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function addMessage(who, cls) {
  const box = document.createElement('div');
  box.className = `msg ${cls}`;
  const head = document.createElement('div');
  head.className = 'msg-head';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = hhmm();
  head.append(w, t);
  const body = document.createElement('div');
  body.className = 'msg-body';
  box.append(head, body);
  messages.appendChild(box);
  messages.scrollTop = messages.scrollHeight;
  return body;
}

function say(who, cls, text) {
  const body = addMessage(who, cls);
  renderMarkdown(body, text);
  return body;
}

function showWarning() {
  warning.hidden = false;
  setTimeout(() => { warning.hidden = true; }, 2500);
}

// separa a tag de humor [x] do início da resposta; null enquanto ainda incompleta
function splitMood(raw) {
  const clean = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();
  if (clean.startsWith('[')) {
    const end = clean.indexOf(']');
    if (end === -1) return clean.length > 20 ? { mood: null, text: clean } : null;
    return { mood: clean.slice(1, end).trim().toLowerCase(), text: clean.slice(end + 1).trimStart() };
  }
  return { mood: null, text: clean };
}

// cursor retangular em bloco: mede o texto até o cursor com um span espelho
const mirror = document.getElementById('mirror');
const caret = document.getElementById('caret');
const field = input.parentElement;
function placeCaret() {
  mirror.textContent = input.value.slice(0, input.selectionStart ?? input.value.length);
  const x = Math.min(mirror.offsetWidth - input.scrollLeft, input.clientWidth - 9);
  caret.style.transform = `translateX(${Math.max(0, x)}px)`;
}
['input', 'keyup', 'click', 'select', 'focus'].forEach((ev) => input.addEventListener(ev, () => requestAnimationFrame(placeCaret)));
input.addEventListener('focus', () => field.classList.add('focused'));
input.addEventListener('blur', () => field.classList.remove('focused'));

const TEXT_LIMIT = 20000;
const history = [];
let busy = false;

const IMAGE_MAX_SIDE = 1280;
const isImage = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name);

// reduz a imagem e devolve base64 (JPEG/PNG) para o modelo de visão
async function imageToBase64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
}

async function readAttachments(files) {
  const parts = [];
  const images = [];
  for (const f of files) {
    if (isImage(f)) {
      try {
        images.push(await imageToBase64(f));
        parts.push(`[Imagem anexada: ${f.name}]`);
      } catch {
        parts.push(`[Imagem anexada (não consegui abrir): ${f.name}]`);
      }
      continue;
    }
    const isText = f.type.startsWith('text/') || /\.(txt|md|json|csv|js|ts|py|html|css|xml|ya?ml|log|ini|cs|java|c|cpp|h|sql)$/i.test(f.name);
    if (isText) {
      const content = (await f.text()).slice(0, TEXT_LIMIT);
      parts.push(`[Arquivo: ${f.name}]\n${content}`);
    } else {
      parts.push(`[Arquivo anexado (conteúdo não legível): ${f.name}]`);
    }
  }
  return { text: parts.join('\n\n'), images };
}

function playGif(src) {
  // um <img> novo garante que o gif comece do primeiro quadro
  const stage = document.createElement('div');
  stage.className = 'banner-stage';
  const img = document.createElement('img');
  img.className = 'banner';
  img.src = src;
  img.alt = '';
  const loading = document.createElement('span');
  loading.className = 'loading';
  loading.textContent = 'Loading...';
  stage.append(img, loading);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = 'Me chamou?';
  splash.replaceChildren(stage, bubble);
}

const BANNER_MS = 2440;
const GREETINGS = [
  '*Sistema online* Inicialização completa, choom! Precisando de mim?',
];
const capriEl = document.getElementById('capri');
let booted = false;
let hiding = false;

async function closeWindow() {
  capriEl.classList.remove('reopen');
  capriEl.classList.add('closing');
  await sleep(260);
}

async function reopenWindow() {
  capriEl.classList.remove('closing', 'reopen');
  void capriEl.offsetWidth;
  capriEl.classList.add('reopen');
  await sleep(480);
}

async function hideWindow() {
  if (hiding) return;
  hiding = true;
  if (!mini) await closeWindow();
  await window.capri.hide();
  hiding = false;
}

// modo mini: os olhos seguem o cursor; duplo clique fecha os olhos e abre o chat
const eyes = document.getElementById('eyes');
const pupils = [
  { el: document.getElementById('pupil-l'), cx: 105, cy: 525, light: document.getElementById('light-l') },
  { el: document.getElementById('pupil-r'), cx: 486, cy: 515, light: document.getElementById('light-r') },
];
let mini = false;

// balão periódico enquanto os olhos estão ativos
const eyesBubble = document.getElementById('eyes-bubble');
let bubbleTimer = null;
let bubbleHide = null;
let lastPhrase = -1;

function showEyesBubble() {
  if (!EYES_PHRASES.length) return;
  let i;
  do { i = Math.floor(Math.random() * EYES_PHRASES.length); } while (i === lastPhrase && EYES_PHRASES.length > 1);
  lastPhrase = i;
  eyesBubble.textContent = EYES_PHRASES[i];
  eyesBubble.hidden = false;
  clearTimeout(bubbleHide);
  bubbleHide = setTimeout(() => { eyesBubble.hidden = true; }, EYES_BUBBLE_SHOW_MS);
}

function startBubbles() {
  stopBubbles();
  bubbleTimer = setInterval(showEyesBubble, EYES_BUBBLE_EVERY_MS);
}

function stopBubbles() {
  clearInterval(bubbleTimer);
  clearTimeout(bubbleHide);
  eyesBubble.hidden = true;
}

// cada pupila anda dentro do olho, na direção do cursor
function lookAt({ x, y }) {
  const area = eyes.querySelector('svg').getBoundingClientRect();
  const k = Math.min(area.width / 736, area.height / 467);
  const ox = area.left + (area.width - 736 * k) / 2;
  const oy = area.top + (area.height - 467 * k) / 2;
  for (const p of pupils) {
    const dx = x - (ox + (p.cx + 80) * k);
    const dy = y - (oy + (p.cy - 258) * k);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(dist / (160 * k + 40), 1) * 36;
    const move = `translate(${(dx / dist) * reach}px, ${(dy / dist) * reach}px)`;
    p.el.style.transform = move;
    p.light.style.transform = move;
  }
}window.capri.onCursor((pos) => { if (mini) lookAt(pos); });

async function enterMini() {
  if (mini || hiding || splash.hidden === false) return;
  mini = true;
  await closeWindow();
  await window.capri.mini(true);
  document.body.classList.add('mini');
  eyes.classList.remove('closing');
  eyes.hidden = false;
  startBubbles();
}

async function leaveMini() {
  if (!mini) return;
  eyes.classList.add('closing');
  stopBubbles();
  await sleep(240);
  await window.capri.mini(false);
  document.body.classList.remove('mini');
  eyes.hidden = true;
  eyes.classList.remove('closing');
  mini = false;
  await reopenWindow();
  input.focus();
}
eyes.addEventListener('dblclick', leaveMini);

// redimensionamento pelas bordas (a janela é transparente e sem moldura)
const MIN_W = 320;
const MIN_H = 360;
const MINI_MIN_W = 140;
const MINI_MAX_W = 900;
const EYES_RATIO = 736 / 467;

function attachGrips(grips) {
  grips.addEventListener('pointerdown', async (e) => {
    const dir = e.target.dataset?.dir;
    if (!dir || e.button !== 0) return;
    e.preventDefault();
    const grip = e.target;
    grip.setPointerCapture(e.pointerId);
    const start = await window.capri.getBounds();
    const sx = e.screenX;
    const sy = e.screenY;
    let pending = false;
    const onMove = (ev) => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const dx = ev.screenX - sx;
        const dy = ev.screenY - sy;
        const hx = dir.includes('e') ? dx : dir.includes('w') ? -dx : 0;
        const vy = dir.includes('s') ? dy : dir.includes('n') ? -dy : 0;
        let { x, y, width, height } = start;
        if (mini) {
          // largura e altura ficam atreladas pela proporção dos olhos
          const byWidth = start.width + hx;
          const byHeight = (start.height + vy) * EYES_RATIO;
          width = Math.round(Math.min(MINI_MAX_W, Math.max(MINI_MIN_W, Math.abs(hx) * 1 >= Math.abs(vy) * EYES_RATIO ? byWidth : byHeight)));
          height = Math.round(width / EYES_RATIO);
        } else {
          width = Math.max(MIN_W, start.width + hx);
          height = Math.max(MIN_H, start.height + vy);
        }
        if (dir.includes('w')) x = start.x + start.width - width;
        if (dir.includes('n')) y = start.y + start.height - height;
        window.capri.setBounds({ x, y, width, height });
      });
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
}
const eyeGrips = document.getElementById('grips').cloneNode(true);
eyeGrips.removeAttribute('id');
eyes.appendChild(eyeGrips);
attachGrips(document.getElementById('grips'));
attachGrips(eyeGrips);

// arrastar a janela pela barra, pelo perfil e pelos olhos
function attachDrag(el) {
  el.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0 || e.target.closest('button, i[data-dir]')) return;
    el.setPointerCapture(e.pointerId);
    const start = await window.capri.getBounds();
    const sx = e.screenX;
    const sy = e.screenY;
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.screenX - sx;
      const dy = ev.screenY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      window.capri.setBounds({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}
attachDrag(document.querySelector('.capri-bar'));
attachDrag(document.querySelector('.profile'));
attachDrag(eyes);
async function boot() {
  status.textContent = 'INICIANDO';
  const modelReady = window.capri.model();

  // o gif toca em loop durante a abertura e até a primeira resposta do modelo
  playGif('icons/CapriBannerCrop.gif');
  await reopenWindow();
  await sleep(BANNER_MS);
  const model = await modelReady;

  // fecha a janela, troca o gif pelo chat e reabre (altura 0 -> final)
  await closeWindow();
  capriEl.classList.remove('splashing');
  splash.hidden = true;
  splash.replaceChildren();
  chat.hidden = false;
  say('Capri', 'capri-msg glitch', GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  await reopenWindow();
  input.focus();

  if (model) {
    status.textContent = `CONNECTED // ${model.toUpperCase()}`;
    status.classList.add('online');
  } else {
    status.textContent = 'SEM LLM';
    status.classList.add('error');
    say('Sistema', 'system', 'Não encontrei o Ollama com o modelo gemma4.');
    showWarning();
  }
}

const TYPING_LINES = ['[Decoding protocol_]', '[Processing // ICE_Breaker]'];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const text = input.value.trim();
  if (!text && attached.length === 0) return;

  const files = attached;
  const names = files.map((f) => f.name);
  say('Você', 'user', [text, ...names.map((n) => `[${n}]`)].filter(Boolean).join(' '));
  input.value = '';
  attached = [];
  renderFiles();

  const att = await readAttachments(files);
  const body = text || (att.images.length ? 'Descreva esta imagem.' : '');
  history.push({ role: 'user', content: [body, att.text].filter(Boolean).join('\n\n'), ...(att.images.length ? { images: att.images } : {}) });

  busy = true;
  const out = addMessage('Capri', 'capri-msg glitch');
  out.classList.add('typing');
  let n = 0;
  out.textContent = TYPING_LINES[0];
  let toolLine = null;
  const ticker = setInterval(() => { if (out.classList.contains('typing')) out.textContent = toolLine ?? TYPING_LINES[++n % TYPING_LINES.length]; }, 900);
  let reply = '';
  let shown = 0; // quantos caracteres já foram 'digitados' na tela
  let failed = false;
  const render = () => {
    const parts = splitMood(reply.slice(0, shown));
    if (!parts || !parts.text) return;
    out.classList.remove('typing');
    setTalking(true);
    renderMarkdown(out, parts.text);
    messages.scrollTop = messages.scrollHeight;
  };
  // digita a resposta aos poucos, acelerando quando há muito texto acumulado
  const typer = setInterval(() => {
    if (shown >= reply.length) return;
    shown = Math.min(reply.length, shown + Math.max(2, Math.ceil((reply.length - shown) / 45)));
    render();
  }, 22);
  await window.capri.chat(history, (msg) => {
    if (msg.token) {
      reply += msg.token;
    } else if (msg.status || msg.tool) {
      toolLine = msg.status ? `[${msg.status}]` : `[${msg.tool}_]`;
      if (out.classList.contains('typing')) out.textContent = toolLine;
    } else if (msg.error) {
      failed = true;
      out.classList.remove('typing');
      out.textContent = `[erro] ${msg.error}`;
    }
  });
  clearInterval(ticker);
  while (shown < reply.length) await new Promise((r) => setTimeout(r, 30));
  clearInterval(typer);
  if (reply) {
    render();
    history.push({ role: 'assistant', content: reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });
  } else {
    history.pop();
    out.classList.remove('typing');
    if (!failed) out.textContent = '[sem resposta]';
    showWarning();
  }
  setTalking(false);
  busy = false;
  input.focus();
});

if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('electron');
}
document.getElementById('minimize').addEventListener('click', enterMini);
document.getElementById('close').addEventListener('click', async () => {
  await closeWindow();
  window.capri.quit();
});
window.capri.onRequestHide(hideWindow);
// a primeira abertura roda a rotina de inicialização; as seguintes só reabrem a janela
window.capri.onShown(() => {
  if (!booted) {
    booted = true;
    boot();
  } else if (!mini) {
    reopenWindow().then(() => input.focus());
  }
});

const feedbackBtn = document.getElementById('feedback');
const paintFeedback = (on) => feedbackBtn.setAttribute('aria-pressed', String(on));
window.capri.getFeedback?.().then(paintFeedback);
feedbackBtn.addEventListener('click', async () => paintFeedback(await window.capri.setFeedback(feedbackBtn.getAttribute('aria-pressed') !== 'true')));
