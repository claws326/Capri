const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { McpHub } = require('./mcp-client');

const OLLAMA = 'http://127.0.0.1:11434';
const USER_NAME = 'Pedro';

// regras de runtime do app, somadas à personalidade definida em AGENT.md
const BASE_RULES = `

## 7. App Runtime Rules (override on conflict)
* The user's name is "${USER_NAME}". Call them "choom" occasionally.
* Reply in the user's language. By default that is Brazilian Portuguese (pt-BR).
* Writing tasks (quoting, writing, explaining, summarizing, translating, brainstorming, coding, general knowledge) are done directly from your own knowledge. Never refuse or ask for more details when the request can be done: make a reasonable choice yourself. Example: "cite a random book passage with 300 words" -> just write one, no questions, no searching.
* You can SEE images the user attaches to the message (vision). Describe, read text (OCR), analyze and answer about them directly from the image. Never say you cannot see images, and never use screen tools for an attached image.
`;

const TOOL_RULES = `
## Computer tools (only for acting on the user's computer or reading their notes)
Tools: list_windows, launch_app, open_url, focus_window, get_active_window_info, get_screen_info, capture_screen, read_screen_text, mouse_click, drag, scroll, keyboard_type, press_key, search_knowledge.
* Use a tool ONLY when the user asks you to do something on the computer (open/close/focus a program, search or open a site, look at the screen, click, type) or to look in their notes/documents. Never use tools for writing or answering questions. Never write tool calls as text.
* Examples. Tool: "abra o Spotify" (launch_app), "pesquise Capri no Opera" (open_url), "o Discord está aberto?" (list_windows), "o que tem na minha tela?" (capture_screen), "qual o prazo do meu projeto?" (search_knowledge). No tool: "cite um trecho de livro", "explique recursão", "qual a capital da França?", "escreva um poema".
* Notes or documents of the user: search_knowledge; answer only from the excerpts and name the file, or say you found nothing.
* For a computer action never ask clarifying questions: assume the window currently in front and act (e.g. "role a página" -> scroll on the active window), then report.
* Actions are real only if you call the tool. Never say you opened/clicked/typed/saw something unless the tool result confirms it; report exactly what it returned and plainly say if it failed.
* While working do not write chat text between steps, just call tools (the app shows a status line). One step at a time, 60 seconds maximum per request; if time runs out say what is done and what is pending. When done, reply with a short result.
`;

const FEEDBACK_RULES = `* Feedback mode is ON: after every action the app shows you the active window and a fresh screenshot. Evaluate it (right window active? field focused? did it work?) and continue or correct before answering.
`;

// Agent Skills (skills/<nome>/SKILL.md): divulgação progressiva — o corpo só entra no prompt quando as ferramentas são oferecidas
const SKILL_CHAR_LIMIT = 6000;
function loadSkills() {
  const out = [];
  try {
    const root = path.join(__dirname, 'skills');
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let raw;
      try { raw = fs.readFileSync(path.join(root, dir.name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const name = m?.[1].match(/^name:\s*(.+)$/m)?.[1].trim() ?? dir.name;
      out.push({ name, body: (m ? m[2] : raw).trim().slice(0, SKILL_CHAR_LIMIT) });
    }
  } catch { /* sem skills */ }
  return out;
}
const skillsText = () => loadSkills().map((s) => `\n## Skill: ${s.name}\n${s.body}\n`).join('');

function loadPersona() {
  try {
    return fs.readFileSync(path.join(__dirname, 'AGENT.md'), 'utf8');
  } catch {
    return 'You are Capri, a chaotic, loyal cyberpunk assistant. Be concise and punchy.';
  }
}

function buildSystemPrompt({ tools = false, feedback = false } = {}) {
  return loadPersona() + BASE_RULES + (tools ? TOOL_RULES + skillsText() + (feedback ? FEEDBACK_RULES : '') : '');
}

// só oferece as ferramentas quando o pedido parece uma ação no computador ou consulta às notas
const ACTION_HINTS = /\b(abr[aeiu]\w*|fech[aeiou]\w*|pesquis\w*|busc[aeiou]\w*|procur\w*|tela|resolu\w+|monitor\w*|janela\w*|rol[aeiu]\w*|scroll\w*|arrast\w*|p[áa]gina|print|screenshot|clic\w*|digit\w*|aperte|pressione|tecla\w*|mouse|navegador|site|url|youtube|google|spotify|opera|chrome|edge|firefox|discord|steam|bloco de notas|notepad|calculadora|programa|aplicativo|app|aberto|aberta|rodando|execut\w*|inicie|iniciar|foco|focar|veja|olhe|olhar|enxerg\w*|leia|nota|notas|anot\w*|lembr\w*|salv\w*|guard\w*|arquivo\w*|documento\w*|projeto|senha|prazo|segredo|ferramenta\w*|skill\w*|meu|minha|meus|minhas)\b/i;
const wantsTools = (text) => ACTION_HINTS.test(String(text || '').normalize('NFC'));
const SYSTEM_PROMPT = buildSystemPrompt();

let controller = null;
const MAX_TOOL_ROUNDS = 25;
const AGENT_TIME_LIMIT_MS = 60000; // guardrail: tempo máximo do loop do agente por mensagem
let toolsOn = true;
// modo "feedback": observa a tela após cada ação e verifica o resultado. Desligado por padrão, para ser rápido.
let feedbackOn = false;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { feedbackOn = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).feedback === true; } catch { /* padrão */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ feedback: feedbackOn })); } catch { /* opcional */ }
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// leitura: a janela da Capri fica fora do print. Ação: não pode interceptar o clique nem roubar o foco.
async function around(readOnly, fn) {
  if (!win || win.isDestroyed()) return fn();
  if (readOnly) {
    win.setContentProtection(true);
    try { return await fn(); } finally { win.setContentProtection(false); }
  }
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  try { return await fn(); } finally { await sleepMs(200); win.setFocusable(true); win.setIgnoreMouseEvents(false); }
}

const hub = new McpHub({
  dataDir: app.getPath('userData'),
  builtinScript: path.join(__dirname, 'mcp', 'screen-server.js'),
  execPath: process.execPath,
  appDir: __dirname,
});
// resumo curto do que a Capri está fazendo, mostrado no lugar do texto enquanto o agente trabalha
function describeTool(name, a = {}) {
  const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
  switch (name) {
    case 'launch_app': return `Abrindo ${cut(a.name ?? 'o programa', 40)}...`;
    case 'keyboard_type': return `Digitando "${cut(a.text ?? '', 40)}"...`;
    case 'focus_window': return `Focando em ${cut(a.name ?? 'a janela', 40)}...`;
    case 'open_url': return a.query ? `Pesquisando "${cut(a.query, 40)}"...` : `Abrindo ${cut(a.url ?? 'o site', 50)}...`;
    case 'search_knowledge': return `Consultando a base de conhecimento: "${cut(a.query ?? '', 40)}"...`;
    case 'scroll': return a.notches > 0 ? 'Rolando para baixo...' : 'Rolando para cima...';
    case 'drag': return 'Arrastando...';
    case 'get_screen_info': return 'Checando a tela...';
    case 'press_key': return `Pressionando ${cut(a.keys ?? 'teclas', 30)}...`;
    case 'mouse_click': return `Clicando em (${a.x}, ${a.y})...`;
    case 'capture_screen': return 'Olhando a tela...';
    case 'read_screen_text': return 'Lendo o texto da tela...';
    case 'list_windows': return a.filter ? `Procurando "${cut(a.filter, 30)}" nas janelas abertas...` : 'Verificando as janelas abertas...';
    case 'get_active_window_info': return 'Checando a janela ativa...';
    default: return `Usando ${name}...`;
  }
}

// verificador independente: com a tela real em mãos, confirma se o pedido foi cumprido (evita falsos positivos)
async function verifyDone(model, request, actions, signal) {
  let windowInfo = '';
  let ocr = '';
  const images = [];
  try {
    if (hub.info('get_active_window_info')) windowInfo = (await around(true, () => hub.call('get_active_window_info', {}))).text;
    if (hub.info('read_screen_text')) ocr = (await around(true, () => hub.call('read_screen_text', {}))).text.slice(0, 1500);
    if (hub.info('capture_screen')) images.push(...(await around(true, () => hub.call('capture_screen', {}))).images);
  } catch { /* sem evidência não há como confirmar */ }
  if (!images.length && !ocr) return { done: false, reason: 'não consegui obter evidência da tela' };
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      keep_alive: KEEP_ALIVE,
      options: { num_ctx: NUM_CTX, temperature: 0 },
      messages: [
        { role: 'system', content: 'You are a strict verifier. Decide, using ONLY the evidence (screenshot, window title, screen text), whether the user request is visibly accomplished right now. If the evidence does not clearly show it, answer false. Reply ONLY with JSON: {"done": true|false, "reason": "short explanation in Portuguese"}.' },
        { role: 'user', content: `Pedido do usuário: ${request}\nAções executadas: ${actions.join('; ') || 'nenhuma'}\nJanela ativa: ${windowInfo}\nTexto na tela: ${ocr || '(vazio)'}`, ...(images.length ? { images } : {}) },
      ],
    }),
  });
  if (!res.ok) return { done: true, reason: '' };
  try {
    const v = JSON.parse((await res.json()).message?.content || '{}');
    return { done: v.done === true, reason: String(v.reason || '') };
  } catch {
    return { done: true, reason: '' };
  }
}
const NUM_CTX = 8192;
const TEMPERATURE = 0.4;
const KEEP_ALIVE = -1;
let loadedModel = null;

async function ollamaUp() {
  try {
    return (await fetch(`${OLLAMA}/api/tags`)).ok;
  } catch {
    return false;
  }
}

async function ensureOllama() {
  if (await ollamaUp()) return true;
  try {
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ollamaUp()) return true;
  }
  return false;
}

// escolhe o gemma4 mais recente instalado, de preferência o e4b
async function pickModel() {
  const { models = [] } = await (await fetch(`${OLLAMA}/api/tags`)).json();
  const found = models
    .filter((m) => /^gemma4:/i.test(m.name))
    .sort((a, b) => (/e4b/.test(b.name) - /e4b/.test(a.name)) || new Date(b.modified_at) - new Date(a.modified_at));
  return found[0]?.name ?? null;
}

let warmPromise = null;

function warmUp() {
  warmPromise = (async () => {
    try {
      if (!(await ensureOllama())) return null;
      const model = await pickModel();
      if (!model) return null;
      loadedModel = model;
      await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: KEEP_ALIVE,
          options: { num_ctx: NUM_CTX, num_predict: 1 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: 'não responda esta mensagem' },
          ],
        }),
      });
      return model;
    } catch {
      return null;
    }
  })();
  return warmPromise;
}

ipcMain.handle('chat:model', () => warmPromise ?? warmUp());
ipcMain.handle('feedback:get', () => feedbackOn);
ipcMain.handle('feedback:set', (_e, on) => { feedbackOn = on === true; saveSettings(); return feedbackOn; });
ipcMain.on('chat:abort', () => controller?.abort());

ipcMain.handle('chat:start', async (event, { id, messages }) => {
  const send = (msg) => event.sender.send('chat:event', { id, ...msg });
  if (!(await ensureOllama())) {
    send({ error: 'Ollama não está rodando e não consegui iniciá-lo.' });
    return;
  }
  const model = await pickModel();
  if (!model) {
    send({ error: 'Nenhum modelo gemma4 instalado. Rode: ollama pull gemma4:e4b' });
    return;
  }

  controller = new AbortController();
  loadedModel = model;
  try {
    const lastUser = String(messages[messages.length - 1]?.content ?? '');
    const hasImage = !!messages[messages.length - 1]?.images?.length;
    const offerTools = toolsOn && !hasImage && wantsTools(lastUser);
    const feedback = offerTools && feedbackOn;
    // só as 2 imagens mais recentes seguem no contexto, para não estourar memória/tempo
    let keep = 2;
    const trimmed = [...messages].reverse().map((m) => {
      if (!m.images?.length) return m;
      if (keep-- > 0) return m;
      const { images, ...rest } = m;
      return { ...rest, content: `${rest.content}\n[imagem anterior omitida]` };
    }).reverse();
    const convo = [{ role: 'system', content: buildSystemPrompt({ tools: offerTools, feedback }) }, ...trimmed];
    let nudged = false;
    const deadline = Date.now() + AGENT_TIME_LIMIT_MS;
    let timedOut = false;
    let didAct = false;
    let verifyTries = 0;
    const actions = [];
    const attempts = new Map(); // ação idêntica repetida = loop sem progresso
    let lastShotHash = null;
    let lastWindow = '';
    const request = String(messages[messages.length - 1]?.content ?? '').slice(0, 1500);
    const tools = offerTools ? await hub.ollamaTools() : [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (!timedOut && Date.now() > deadline) {
        timedOut = true;
        convo.push({ role: 'user', content: 'O limite de 60 segundos do agente acabou. Sem usar mais ferramentas, diga o que já foi feito e o que ficou pendente.' });
      }
      const useTools = offerTools && !timedOut && round < MAX_TOOL_ROUNDS - 1;
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          think: false,
          keep_alive: KEEP_ALIVE,
          options: { num_ctx: NUM_CTX, temperature: TEMPERATURE },
          ...(useTools && tools.length ? { tools } : {}),
          messages: convo,
        }),
      });
      if (!res.ok) {
        send({ error: `Ollama respondeu ${res.status}: ${await res.text()}` });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const calls = [];
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const data = JSON.parse(line);
          if (data.error) send({ error: data.error });
          else {
            if (data.message?.tool_calls) calls.push(...data.message.tool_calls);
            if (data.message?.content) {
              content += data.message.content;
              // sem ferramentas não há o que esconder: o texto segue ao vivo; com ferramentas, só a resposta final é exibida
              if (!tools.length) send({ token: data.message.content });
            } else if (data.message?.thinking) send({ thinking: true });
          }
        }
      }
      if (!calls.length && tools.length) {
        // o modelo às vezes escreve a chamada como texto ("Tool: nome{arg:<|"|>x<|"|>}") em vez de chamá-la
        for (const m of content.matchAll(/(?:Tool:\s*)?\b([a-z_]+)\s*(?:\{([^{}]*)\})?/g)) {
          if (!hub.info(m[1]) || (!m[2] && !/Tool:\s*[a-z_]+/.test(m[0]))) continue;
          const args = {};
          for (const kv of (m[2] ?? '').matchAll(/(\w+)\s*:\s*(?:<\|"\|>([\s\S]*?)<\|"\|>|"([^"]*)"|([^,}\s]+))/g)) {
            const raw = kv[2] ?? kv[3] ?? kv[4];
            args[kv[1]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
          }
          calls.push({ function: { name: m[1], arguments: args } });
        }
        if (calls.length) content = '';
      }
      if (!calls.length) {
        // após ferramentas, o modelo às vezes encerra o turno sem dizer nada: pede a resposta uma vez
        if (!content && round > 0 && !nudged) {
          nudged = true;
          convo.push({ role: 'user', content: 'Com base no resultado das ferramentas, responda ao meu pedido.' });
          continue;
        }
        // antes de declarar sucesso, um verificador confere a tela de verdade
        if (feedback && didAct && content && !timedOut) {
          send({ status: 'Conferindo o resultado...' });
          const v = await verifyDone(model, request, actions, controller.signal);
          if (!v.done) {
            convo.push({ role: 'assistant', content });
            if (verifyTries++ < 2 && Date.now() < deadline) {
              convo.push({ role: 'user', content: `[VERIFICADOR] O pedido NÃO está confirmado na tela: ${v.reason}. Continue com as ferramentas para concluir, sem afirmar sucesso antes de ver o resultado.` });
            } else {
              timedOut = true;
              convo.push({ role: 'user', content: `[VERIFICADOR] Não foi possível confirmar o resultado (${v.reason}). Sem usar ferramentas, diga ao usuário com honestidade o que foi feito e o que não deu para confirmar.` });
            }
            continue;
          }
        }
        if (content && tools.length) send({ token: content });
        break;
      }

      convo.push({ role: 'assistant', content: '', tool_calls: calls });
      const images = [];
      let acted = false;
      let captured = false;
      for (const call of calls) {
        const name = call.function?.name;
        send({ status: describeTool(name, call.function?.arguments) });
        actions.push(describeTool(name, call.function?.arguments).replace(/\.\.\.$/, ''));
        const meta = hub.info(name);
        let result;
        if (Date.now() > deadline) {
          convo.push({ role: 'tool', tool_name: name, content: 'Limite de tempo do agente atingido; ferramenta não executada.' });
          continue;
        }
        const sig = meta && !meta.readOnly ? name + JSON.stringify(call.function?.arguments ?? {}) : null;
        if (sig && (attempts.set(sig, (attempts.get(sig) ?? 0) + 1), attempts.get(sig) > 2)) {
          convo.push({ role: 'tool', tool_name: name, content: 'Ação idêntica já executada 2 vezes sem resolver. Não repita: mude de estratégia (atalho de teclado, outra ferramenta) ou pare e relate ao usuário o que viu.' });
          continue;
        }
        if (!meta) result = { text: `Erro: ferramenta desconhecida "${name}".`, images: [] };
        else {
          const args = call.function?.arguments;
          try {
            result = await around(meta.readOnly, () => hub.call(name, args));
          } catch (e) {
            result = { text: `Erro: ${e.message}`, images: [] };
          }
        }
        convo.push({ role: 'tool', tool_name: name, content: result.text });
        images.push(...result.images);
        if (meta && !meta.readOnly) { acted = true; didAct = true; }
        if (name === 'capture_screen') captured = true;
      }
      // Observar: depois de agir, o app mostra sozinho o estado da tela para a Capri avaliar o resultado
      if (feedback && acted && !timedOut && Date.now() < deadline) {
        await sleepMs(1500); // dá tempo de programas abrirem antes de observar
        let win0 = '';
        try {
          if (hub.info('get_active_window_info')) win0 = (await around(true, () => hub.call('get_active_window_info', {}))).text;
          if (!captured && hub.info('capture_screen')) images.push(...(await around(true, () => hub.call('capture_screen', {}))).images);
        } catch { /* observação é opcional */ }
        // detecção de mudança: compara janela ativa e print com a observação anterior
        const hash = images.length ? crypto.createHash('md5').update(String(images[images.length - 1])).digest('hex') : null;
        const changes = [];
        if (lastWindow && win0 && win0 !== lastWindow) changes.push('a janela ativa mudou');
        if (hash && lastShotHash && hash !== lastShotHash) changes.push('o conteúdo da tela mudou');
        const delta = hash && lastShotHash ? (changes.length ? ` Mudanças desde a última observação: ${changes.join('; ')}.` : ' ATENÇÃO: nada mudou na tela desde a última observação; sua ação provavelmente não teve efeito.') : '';
        lastShotHash = hash ?? lastShotHash;
        lastWindow = win0 || lastWindow;
        convo.push({ role: 'user', content: '[OBSERVAÇÃO AUTOMÁTICA após sua ação] Janela ativa: ' + (win0 || 'desconhecida') + '.' + delta + ' Avalie: a ação deu o resultado esperado? Se o pedido ainda não está completo, chame a próxima ferramenta AGORA (não diga apenas que vai fazer). Se está completo, responda ao usuário. Se a janela esperada ainda não apareceu, confirme com list_windows antes de concluir que falhou.' });
      }
      // o print vai como imagem em uma mensagem de usuário, que é o formato que o modelo de visão aceita
      if (images.length) for (const m of convo) if (m.images && m.content === '[print atual da tela]') delete m.images;
      if (images.length) convo.push({ role: 'user', content: '[print atual da tela]', images });
    }
    send({ done: true });
  } catch (err) {
    if (err.name === 'AbortError') send({ done: true });
    else send({ error: err.message });
  } finally {
    controller = null;
  }
});

let win = null;
let tray = null;
let quitting = false;
let shownOnce = false;
let hideTimer = null;
let lastBlur = 0;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow() {
  win = new BrowserWindow({
    width: 404,
    height: 504,
    show: false,
    skipTaskbar: true,
    icon: path.join(__dirname, 'icons', 'CapriIcon.png'),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    title: 'Capri',
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('blur', () => { lastBlur = Date.now(); });
  win.on('moved', savePos);
  win.loadFile(path.join(__dirname, 'index.html'));
  // fechar só esconde: a Capri continua em segundo plano
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (normalBounds) return;
    win.hide();
  });
}

function placeNearTray() {
  if (normalBounds) return;
  if (savedPos) return win.setPosition(savedPos.x, savedPos.y);
  const anchor = tray ? tray.getBounds() : null;
  const display = anchor ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }) : screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const [w, h] = win.getSize();
  win.setPosition(Math.round(x + width - w - 8), Math.round(y + height - h - 8));
}

const posFile = () => path.join(app.getPath('userData'), 'window-pos.json');
let savedPos = null;
function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    // só reaproveita se ainda estiver dentro de algum monitor
    const ok = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return p.x + 100 > b.x && p.x < b.x + b.width - 100 && p.y >= b.y - 10 && p.y < b.y + b.height - 60;
    });
    if (ok) savedPos = { x: p.x, y: p.y };
  } catch {}
}
function savePos() {
  if (!win || win.isDestroyed() || normalBounds) return;
  const [x, y] = win.getPosition();
  savedPos = { x, y };
  try { fs.writeFileSync(posFile(), JSON.stringify(savedPos)); } catch {}
}

// modo mini: a janela encolhe para os olhos, que seguem o cursor na tela inteira
let eyesBounds = null;
const miniH = (w) => Math.round(w * 467 / 736);
let normalBounds = null;
let cursorTimer = null;
let topTimer = null;

// jogos em tela cheia sem borda cobrem janelas comuns: usa o nível mais alto e reafirma a cada segundo
function keepOnTop() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.moveTop();
}

function setMini(on) {
  if (!win) return;
  clearInterval(cursorTimer);
  cursorTimer = null;
  if (on) {
    if (!normalBounds) normalBounds = win.getBounds();
    const b = normalBounds;
    // na primeira vez os olhos nascem onde o chat estava; depois voltam à última posição deles
    const w = eyesBounds?.width ?? 400;
    win.setBounds(eyesBounds ?? { x: b.x + b.width - w, y: b.y + b.height - miniH(w), width: w, height: miniH(w) });
    keepOnTop();
    topTimer = setInterval(keepOnTop, 1000);
    cursorTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const p = screen.getCursorScreenPoint();
      const b2 = win.getBounds();
      win.webContents.send('eyes:cursor', { x: p.x - b2.x, y: p.y - b2.y, w: b2.width, h: b2.height });
    }, 33);
  } else if (normalBounds) {
    clearInterval(topTimer);
    topTimer = null;
    win.setAlwaysOnTop(false);
    eyesBounds = win.getBounds();
    const n = normalBounds;
    const wa = screen.getDisplayMatching(n).workArea;
    const nx = Math.min(Math.max(n.x, wa.x), wa.x + wa.width - n.width);
    const ny = Math.min(Math.max(n.y, wa.y), wa.y + wa.height - n.height);
    win.setBounds({ ...n, x: nx, y: ny });
    normalBounds = null;
    savePos();
  }
}

ipcMain.handle('window:mini', (_e, on) => setMini(!!on));
ipcMain.handle('window:get-bounds', () => win?.getBounds());
ipcMain.on('window:set-bounds', (_e, b) => {
  if (!win) return;
  const ok = [b?.x, b?.y, b?.width, b?.height].every(Number.isFinite);
  if (!ok) return;
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  if (normalBounds) eyesBounds = win.getBounds();
  else savePos();
});

function showWindow() {
  if (!win) return;
  clearTimeout(hideTimer);
  if (!shownOnce) placeNearTray();
  shownOnce = true;
  win.show();
  win.moveTop();
  win.focus();
  const notify = () => win.webContents.send('window:shown');
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', notify);
  else notify();
}

function toggleWindow() {
  if (normalBounds) return keepOnTop();
  // clicar na bandeja tira o foco da janela, então conta como "focada" se perdeu o foco há instantes
  const wasActive = win.isFocused() || Date.now() - lastBlur < 500;
  if (win.isVisible() && !win.isMinimized() && wasActive) {
    win.webContents.send('window:request-hide');
    // se o renderer não responder, esconde mesmo assim
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (win.isVisible()) win.hide(); }, 900);
  } else {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) placeNearTray();
    showWindow();
  }
}

ipcMain.handle('window:quit', () => app.quit());
ipcMain.handle('window:hide', () => {
  if (normalBounds) return;
  clearTimeout(hideTimer);
  win?.hide();
});

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icons', 'CapriIcon.png')).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Capri');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Capri', click: () => showWindow() },
      { label: 'Ferramentas MCP (tela)', type: 'checkbox', checked: toolsOn, click: (item) => { toolsOn = item.checked; } },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]),
  );
  tray.on('click', toggleWindow);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  loadPos();
  loadSettings();
  createWindow();
  createTray();
  warmUp();
  hub.start();
  showWindow();
});
let unloaded = false;
app.on('before-quit', (e) => {
  quitting = true;
  hub.close();
  if (unloaded || !loadedModel) return;
  e.preventDefault();
  unloaded = true;
  const done = () => app.quit();
  fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: loadedModel, keep_alive: 0 }),
    signal: AbortSignal.timeout(5000),
  }).then(done, done);
});
// continua rodando em segundo plano mesmo sem janelas visíveis
app.on('window-all-closed', () => {});
