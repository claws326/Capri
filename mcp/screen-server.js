#!/usr/bin/env node
// Servidor MCP (stdio) de monitoramento e interação de tela para Windows.
// Independente do Capri: qualquer cliente MCP pode usá-lo. Nada pode ser escrito em stdout além do protocolo.
//
// Coordenadas: todas no "espaço da imagem" = tela principal reduzida para no máximo MAX_W px de largura.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const MAX_W = 1280;
const SHOTS_DIR = process.env.CAPRI_SCREENS_DIR || path.join(os.tmpdir(), 'capri-screens');
const PS_HEAD = 'Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; Add-Type -Name D -Namespace P -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; [void][P.D]::SetProcessDPIAware(); [Console]::OutputEncoding = [Text.Encoding]::UTF8;';

function ps(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS_HEAD + script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout.trim())),
    );
  });
}

async function geometry() {
  const [w, h] = (await ps('$b = [Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width),$($b.Height)"')).split(',').map(Number);
  const s = Math.max(1, w / MAX_W);
  return { physW: w, physH: h, s, vw: Math.round(w / s), vh: Math.round(h / s) };
}

function physRect(region, g) {
  if (!region) return { x: 0, y: 0, w: g.physW, h: g.physH };
  const x = Math.max(0, Math.round(region[0] * g.s));
  const y = Math.max(0, Math.round(region[1] * g.s));
  const w = Math.min(g.physW - x, Math.round(region[2] * g.s));
  const h = Math.min(g.physH - y, Math.round(region[3] * g.s));
  if (w < 4 || h < 4) throw new Error('region fora da tela ou pequena demais');
  return { x, y, w, h };
}

const CAPTURE = `
$x = [int]$env:CAPRI_X; $y = [int]$env:CAPRI_Y; $w = [int]$env:CAPRI_W; $h = [int]$env:CAPRI_H
$ow = [int]$env:CAPRI_OW; $oh = [int]$env:CAPRI_OH
$bmp = New-Object Drawing.Bitmap $w, $h
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()
if ($ow -ne $w -or $oh -ne $h) {
  $o = New-Object Drawing.Bitmap $ow, $oh
  $g2 = [Drawing.Graphics]::FromImage($o)
  $g2.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $ow, $oh)
  $g2.Dispose(); $bmp.Dispose(); $bmp = $o
}
$fmt = if ($env:CAPRI_OUT -match '\\.jpe?g$') { [Drawing.Imaging.ImageFormat]::Jpeg } else { [Drawing.Imaging.ImageFormat]::Png }
$bmp.Save($env:CAPRI_OUT, $fmt)
$bmp.Dispose()
`;

// captura uma região (pixels reais) para um arquivo, já reduzida para outW x outH
async function capture(rect, outW, outH, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ps(CAPTURE, {
    CAPRI_X: rect.x, CAPRI_Y: rect.y, CAPRI_W: rect.w, CAPRI_H: rect.h, CAPRI_OW: outW, CAPRI_OH: outH, CAPRI_OUT: file,
  });
}

function shotName(wanted, fallback) {
  // só o nome do arquivo conta: o modelo não escolhe pastas
  const name = path.basename(String(wanted || '')).replace(/[^\w.-]/g, '_') || fallback;
  return path.join(SHOTS_DIR, /\.(png|jpe?g)$/i.test(name) ? name : `${name}.png`);
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true });
const guard = (fn) => async (args) => {
  try { return await fn(args ?? {}); } catch (e) { return fail(e); }
};

// observação leve embutida em toda ação: título da janela ativa depois dela (sem custo de imagem)
async function activeTitle() {
  try {
    await new Promise((r) => setTimeout(r, 250));
    return JSON.parse(await ps(WINDOW)).title || '(sem título)';
  } catch { return '(desconhecida)'; }
}
const withWindow = async (msg) => text(`${msg} Janela ativa agora: "${await activeTitle()}".`);

// ponteiros (clique, rolagem, arrasto) usam o espaço da ÚLTIMA imagem que o modelo viu: sem contas de zoom/recorte para ele
let view = { x0: 0, y0: 0, zoom: 1, w: null, h: null };
function toScreen(x, y, g) {
  const w = view.w ?? g.vw;
  const h = view.h ?? g.vh;
  if (x < 0 || y < 0 || x > w || y > h) throw new Error(`coordenada (${x}, ${y}) fora da última imagem (${w}x${h}); capture a tela de novo`);
  return { x: Math.round((view.x0 + x / view.zoom) * g.s), y: Math.round((view.y0 + y / view.zoom) * g.s) };
}

const region = z.array(z.number().int()).length(4).optional();

const server = new McpServer({ name: 'capri-screen', version: '1.0.0' });

server.registerTool('capture_screen', {
  description: 'Tira um print da tela e o mostra para você. Use antes de agir na tela para saber o que há nela.',
  inputSchema: {
    region: region.describe('Opcional: [x, y, largura, altura] no espaço da imagem. Omitido = tela inteira.'),
    active_window: z.boolean().optional().describe('Se true, captura só a janela em primeiro plano (ampliada). Ótimo para apps pequenos como a Calculadora.'),
    save_path: z.string().optional().describe('Opcional: nome do arquivo (ex: screen.png).'),
  },
  annotations: { readOnlyHint: true, title: 'Capturar tela' },
}, guard(async ({ region: r, save_path, active_window }) => {
  const g = await geometry();
  if (active_window && !r) {
    const w = JSON.parse(await ps(WINDOW));
    const x = Math.max(0, Math.round(w.l / g.s));
    const y = Math.max(0, Math.round(w.t / g.s));
    r = [x, y, Math.min(g.vw - x, Math.round(w.w / g.s)), Math.min(g.vh - y, Math.round(w.h / g.s))];
  }
  const rect = physRect(r, g);
  // recortes pequenos são ampliados: o modelo não enxerga detalhes em imagens minúsculas
  const base = Math.min(rect.w, rect.h) / g.s;
  const zoom = r ? Math.max(1, Math.min(4, 480 / base, 1600 / (Math.max(rect.w, rect.h) / g.s))) : 1;
  const ow = Math.max(1, Math.round((rect.w / g.s) * zoom));
  const oh = Math.max(1, Math.round((rect.h / g.s) * zoom));
  const saved = shotName(save_path, 'screen.png');
  await capture(rect, ow, oh, saved);
  view = { x0: r ? r[0] : 0, y0: r ? r[1] : 0, zoom: r ? zoom : 1, w: ow, h: oh };
  // o modelo recebe um JPEG (leve); o arquivo pedido fica salvo em disco
  const jpg = path.join(SHOTS_DIR, '_view.jpg');
  await capture(rect, ow, oh, jpg);
  // limite de payload: se o JPEG ficou grande demais, refaz mais leve (80% do tamanho)
  if (fs.statSync(jpg).size > 900 * 1024) await capture(rect, Math.round(ow * 0.8), Math.round(oh * 0.8), jpg);
  return {
    content: [
      { type: 'text', text: r && zoom > 1 ? `Recorte ampliado ${zoom.toFixed(1)}x (${ow}x${oh}). Para clicar, use coordenadas DESTA imagem (pixels que você vê nela); o app converte para a tela. A tela inteira tem ${g.vw}x${g.vh}.` : `Imagem ${ow}x${oh}; a tela inteira tem ${g.vw}x${g.vh}. Para clicar, use coordenadas desta imagem.` },
      { type: 'image', data: fs.readFileSync(jpg).toString('base64'), mimeType: 'image/jpeg' },
    ],
  };
}));

const OCR = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:CAPRI_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw 'OCR do Windows indisponível (instale um pacote de idioma).' }
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$res.Text
`;

server.registerTool('read_screen_text', {
  description: 'Lê o texto visível na tela (OCR do Windows), na tela inteira ou em uma região.',
  inputSchema: { region: region.describe('Opcional: [x, y, largura, altura] no espaço da imagem.') },
  annotations: { readOnlyHint: true, title: 'Ler texto da tela (OCR)' },
}, guard(async ({ region: r }) => {
  const g = await geometry();
  const rect = physRect(r, g);
  const file = shotName('_ocr.png');
  await capture(rect, rect.w, rect.h, file); // OCR lê melhor em resolução real
  const out = await ps(OCR, { CAPRI_OCR_FILE: file });
  return text(out ? out.slice(0, 6000) : '(nenhum texto encontrado)');
}));

const CLICK = `
Add-Type -Name M -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);'
[void][P.M]::SetCursorPos([int]$env:CAPRI_X, [int]$env:CAPRI_Y)
Start-Sleep -Milliseconds 60
$down = @{ left = 0x2; right = 0x8; middle = 0x20 }[$env:CAPRI_BTN]
$up = $down * 2
for ($i = 0; $i -lt [int]$env:CAPRI_N; $i++) { [P.M]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [P.M]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
`;

server.registerTool('mouse_click', {
  description: 'Move o mouse e clica nas coordenadas da ÚLTIMA imagem de capture_screen (mesmo que seja um recorte ampliado: use os pixels que você vê nela).',
  inputSchema: {
    x: z.number().int().describe('Posição horizontal.'),
    y: z.number().int().describe('Posição vertical.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Padrão: left.'),
    double_click: z.boolean().optional().describe('Padrão: false.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, title: 'Clicar com o mouse' },
}, guard(async ({ x, y, button, double_click }) => {
  const g = await geometry();
  const pt = toScreen(x, y, g);
  await ps(CLICK, { CAPRI_X: pt.x, CAPRI_Y: pt.y, CAPRI_BTN: button ?? 'left', CAPRI_N: double_click ? 2 : 1 });
  return withWindow(`Clique realizado em (${x}, ${y}).`);
}));

const SCROLL = `
Add-Type -Name M -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);'
if ($env:CAPRI_X) { [void][P.M]::SetCursorPos([int]$env:CAPRI_X, [int]$env:CAPRI_Y); Start-Sleep -Milliseconds 60 }
$d = [int]$env:CAPRI_NOTCHES * 120
[P.M]::mouse_event(0x0800, 0, 0, [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$d), 0), [UIntPtr]::Zero)
`;

server.registerTool('scroll', {
  description: 'Rola a roda do mouse. notches > 0 rola para BAIXO, < 0 para CIMA (cada unidade ≈ 3 linhas). Opcional x,y posiciona o mouse antes (espaço da imagem). Depois confira com capture_screen.',
  inputSchema: {
    notches: z.number().int().min(-30).max(30).describe('Quantidade de "cliques" da roda; positivo = para baixo.'),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, title: 'Rolar a tela' },
}, guard(async ({ notches, x, y }) => {
  const g = await geometry();
  const env = { CAPRI_NOTCHES: -notches };
  if (x !== undefined && y !== undefined) {
    const pt = toScreen(x, y, g);
    env.CAPRI_X = pt.x;
    env.CAPRI_Y = pt.y;
  }
  await ps(SCROLL, env);
  return withWindow(`Rolagem de ${notches} ${notches > 0 ? '(para baixo)' : '(para cima)'}.`);
}));

const DRAG = `
Add-Type -Name M -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);'
$x1 = [int]$env:CAPRI_X1; $y1 = [int]$env:CAPRI_Y1; $x2 = [int]$env:CAPRI_X2; $y2 = [int]$env:CAPRI_Y2
[void][P.M]::SetCursorPos($x1, $y1); Start-Sleep -Milliseconds 120
[P.M]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120
for ($i = 1; $i -le 12; $i++) { [void][P.M]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / 12), [int]($y1 + ($y2 - $y1) * $i / 12)); Start-Sleep -Milliseconds 25 }
Start-Sleep -Milliseconds 120
[P.M]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
`;

server.registerTool('drag', {
  description: 'Arrasta com o botão esquerdo de (x1,y1) até (x2,y2), no espaço da imagem do capture_screen. Serve para mover janelas, arrastar arquivos e barras.',
  inputSchema: { x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: true, title: 'Arrastar e soltar' },
}, guard(async ({ x1, y1, x2, y2 }) => {
  const g = await geometry();
  const a = toScreen(x1, y1, g);
  const b = toScreen(x2, y2, g);
  await ps(DRAG, { CAPRI_X1: a.x, CAPRI_Y1: a.y, CAPRI_X2: b.x, CAPRI_Y2: b.y });
  return withWindow(`Arrastado de (${x1}, ${y1}) para (${x2}, ${y2}).`);
}));

server.registerTool('get_screen_info', {
  description: 'Informa o tamanho real da tela, o tamanho do espaço de coordenadas das imagens, o fator de escala e onde o mouse está. Útil como pré-checagem antes de clicar.',
  inputSchema: {},
  annotations: { readOnlyHint: true, title: 'Informações da tela' },
}, guard(async () => {
  const g = await geometry();
  const [cx, cy] = (await ps('$p = [Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"')).split(',').map(Number);
  return text(JSON.stringify({
    real_pixels: { width: g.physW, height: g.physH },
    coordinate_space: { width: g.vw, height: g.vh },
    scale_factor: Number(g.s.toFixed(3)),
    mouse: { x: Math.round(cx / g.s), y: Math.round(cy / g.s) },
    monitors: 'apenas o monitor principal é capturado e controlado',
  }));
}));

const TYPE = `
$old = $null
try { $old = [Windows.Forms.Clipboard]::GetText() } catch {}
[Windows.Forms.Clipboard]::SetText($env:CAPRI_TEXT)
if ($env:CAPRI_REPLACE -eq '1') { [Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 80 }
[Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 150
if ($env:CAPRI_ENTER -eq '1') { [Windows.Forms.SendKeys]::SendWait('{ENTER}') }
if ($old) { [Windows.Forms.Clipboard]::SetText($old) } else { [Windows.Forms.Clipboard]::Clear() }
`;

server.registerTool('keyboard_type', {
  description: 'Digita texto na janela com foco. Clique no campo certo com mouse_click antes.',
  inputSchema: {
    text: z.string().min(1).describe('O texto exato a digitar.'),
    press_enter: z.boolean().optional().describe('Pressiona Enter depois. Padrão: false.'),
    replace: z.boolean().optional().describe('Seleciona tudo (Ctrl+A) antes, para substituir o texto que já está no campo. Padrão: false.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, title: 'Digitar texto' },
}, guard(async ({ text: t, press_enter, replace }) => {
  // colar pela área de transferência preserva acentos e símbolos
  await ps(TYPE, { CAPRI_TEXT: t, CAPRI_ENTER: press_enter ? '1' : '0', CAPRI_REPLACE: replace ? '1' : '0' });
  return withWindow(`Texto digitado${replace ? ' (substituindo o conteúdo do campo)' : ''}${press_enter ? ' e Enter pressionado' : ''}.`);
}));

const WINDOW = `
Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct RECT { public int L, T, R, B; } public static class P2 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }'
$h = [P.W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][P.W]::GetWindowText($h, $sb, 512)
$r = New-Object RECT
[void][P2]::GetWindowRect($h, [ref]$r)
@{ title = $sb.ToString(); l = $r.L; t = $r.T; w = $r.R - $r.L; h = $r.B - $r.T } | ConvertTo-Json -Compress
`;

server.registerTool('get_active_window_info', {
  description: 'Informa título, posição e tamanho da janela em primeiro plano (espaço da imagem).',
  inputSchema: {},
  annotations: { readOnlyHint: true, title: 'Janela ativa' },
}, guard(async () => {
  const g = await geometry();
  const w = JSON.parse(await ps(WINDOW));
  const r = (n) => Math.round(n / g.s);
  return text(JSON.stringify({ title: w.title, position: { x: r(w.l), y: r(w.t) }, size: { width: r(w.w), height: r(w.h) } }));
}));

const LIST = `
$f = $env:CAPRI_FILTER
$w = Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ app = $_.ProcessName; title = $_.MainWindowTitle } }
$p = @()
if ($f) { $p = @(Get-Process -Name "*$f*" -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) }
@{ windows = @($w); matching_processes = $p } | ConvertTo-Json -Compress -Depth 4
`;

server.registerTool('list_windows', {
  description: 'Lista as janelas abertas (app e título) sem usar imagem. É a forma mais confiável de saber se um programa está aberto. Com filter, também diz se há processo com esse nome (mesmo sem janela, ex.: na bandeja).',
  inputSchema: { filter: z.string().optional().describe('Opcional: parte do nome do app, ex: spotify.') },
  annotations: { readOnlyHint: true, title: 'Listar janelas abertas' },
}, guard(async ({ filter }) => {
  const out = JSON.parse(await ps(LIST, { CAPRI_FILTER: (filter || '').replace(/[^\w .-]/g, '') }));
  const f = (filter || '').toLowerCase();
  const windows = (out.windows || []).filter((w) => !f || `${w.app} ${w.title}`.toLowerCase().includes(f));
  return text(JSON.stringify({ windows, matching_processes: out.matching_processes || [] }));
}));

const LAUNCH = `
$n = $env:CAPRI_APP
$app = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1
if ($app) { Start-Process "shell:AppsFolder\\$($app.AppID)"; "Abri: $($app.Name) (use focus_window se ele não vier para a frente)" }
else { Start-Process $n -ErrorAction Stop; "Abri: $n" }
`;

server.registerTool('launch_app', {
  description: 'Abre um programa instalado pelo nome (ex: Spotify, Calculadora, Notepad), como se estivesse no Menu Iniciar. Prefira esta ferramenta a clicar no Menu Iniciar.',
  inputSchema: { name: z.string().min(1).describe('Nome do programa.') },
  annotations: { readOnlyHint: false, title: 'Abrir programa' },
}, guard(async ({ name }) => {
  const out = await ps(LAUNCH, { CAPRI_APP: name.replace(/[^\w .-]/g, '') });
  return text(out || 'Programa iniciado.');
}));

const FOCUS = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class F { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
$n = $env:CAPRI_FOCUS
$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$n*" -or $_.MainWindowTitle -like "*$n*") } | Select-Object -First 1
if (-not $w) { throw "Nenhuma janela encontrada para '$n'." }
$h = $w.MainWindowHandle
if ([F]::IsIconic($h)) { [void][F]::ShowWindow($h, 9) }
[F]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [F]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][F]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 300
if ([F]::GetForegroundWindow() -ne $h) {
  # reserva: AppActivate resolve janelas UWP (ex.: Calculadora) que o SetForegroundWindow não traz
  try { [void](New-Object -ComObject WScript.Shell).AppActivate($w.MainWindowTitle) } catch {}
  Start-Sleep -Milliseconds 400
}
if ([F]::GetForegroundWindow() -eq $h) { "Foco em: $($w.MainWindowTitle)" } else { throw "Não consegui trazer '$($w.MainWindowTitle)' para a frente." }
`;

server.registerTool('focus_window', {
  description: 'Traz uma janela já aberta para a frente e dá foco a ela (por parte do nome do app ou do título, ex: opera). Use antes de digitar ou pressionar teclas em um app que já estava aberto.',
  inputSchema: { name: z.string().min(1).describe('Parte do nome do app ou do título.') },
  annotations: { readOnlyHint: false, title: 'Focar janela' },
}, guard(async ({ name }) => text(await ps(FOCUS, { CAPRI_FOCUS: name.replace(/[^\w .-]/g, '') }))));
const OPEN_URL = `
$url = $env:CAPRI_URL
$b = $env:CAPRI_BROWSER
$exe = $null
if ($b) {
  foreach ($root in 'HKCU','HKLM') {
    $k = "$($root):\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$b.exe"
    if (Test-Path $k) { $exe = (Get-ItemProperty $k).'(default)'; break }
  }
  if (-not $exe) { $g = Get-Process -Name $b -ErrorAction SilentlyContinue | Select-Object -First 1; if ($g) { $exe = $g.Path } }
  if (-not $exe) { $c = Get-ChildItem "$env:LOCALAPPDATA\\Programs\\$b*\\$b.exe","$env:ProgramFiles\\$b*\\$b.exe" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $exe = $c.FullName } }
}
if ($exe) { Start-Process $exe -ArgumentList $url; "Abri no $b - $url" } else { Start-Process $url; "Abri no navegador padrão - $url" }
`;

server.registerTool('open_url', {
  description: 'Abre um site ou faz uma pesquisa na web no navegador, de forma confiável (sem clicar nem digitar). Passe "query" para pesquisar no Google, ou "url" para abrir um endereço. Prefira esta ferramenta a digitar na barra de endereço.',
  inputSchema: {
    query: z.string().optional().describe('Texto a pesquisar no Google.'),
    url: z.string().optional().describe('Endereço http(s) a abrir.'),
    browser: z.string().optional().describe('Opcional: opera, chrome, msedge, firefox. Omitido = navegador padrão.'),
  },
  annotations: { readOnlyHint: false, title: 'Abrir site / pesquisar' },
}, guard(async ({ query, url, browser }) => {
  let target = url;
  if (!target && query) target = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  if (!target) throw new Error('informe query ou url');
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  const out = await ps(OPEN_URL, { CAPRI_URL: target, CAPRI_BROWSER: (browser || '').replace(/[^\w-]/g, '') });
  return text(out);
}));
server.registerTool('press_key', {
  description: 'Pressiona teclas na janela com foco, em sintaxe SendKeys: {ENTER}, {ESC}, {TAB}, {DOWN}, ^c (Ctrl+C), %{F4} (Alt+F4), ^{ESC}.',
  inputSchema: { keys: z.string().min(1).describe('Teclas em sintaxe SendKeys.') },
  annotations: { readOnlyHint: false, destructiveHint: true, title: 'Pressionar teclas' },
}, guard(async ({ keys }) => {
  await ps('[Windows.Forms.SendKeys]::SendWait($env:CAPRI_KEYS)', { CAPRI_KEYS: keys });
  return withWindow(`Teclas enviadas: ${keys}.`);
}));
server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`capri-screen: ${e.message}\n`);
  process.exit(1);
});
