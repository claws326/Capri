#!/usr/bin/env node
// Servidor MCP de RAG local: indexa arquivos .md/.txt de pastas de conhecimento e responde buscas.
// Busca híbrida: embeddings do Ollama (se o modelo existir) + palavras-chave (BM25), fundidas por RRF.
// Nada sai da máquina: os embeddings vêm do Ollama local. Stdout é só do protocolo.
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.CAPRI_EMBED_MODEL || 'nomic-embed-text';
const DIRS = (process.env.CAPRI_KNOWLEDGE_DIRS || '').split(path.delimiter).filter(Boolean);
const INDEX_FILE = process.env.CAPRI_INDEX_FILE || path.join(process.cwd(), 'rag-index.json');
const EXTS = new Set(['.md', '.txt']);
const CHUNK = 900;
const OVERLAP = 150;

let index = { model: EMBED_MODEL, files: {} }; // files[path] = { sig, chunks: [{ text, vec? }] }
try {
  const saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  if (saved.model === EMBED_MODEL) index = saved;
} catch { /* índice novo */ }

function listFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
      else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  for (const d of DIRS) walk(d, 0);
  return out;
}

// quebra em trechos por parágrafo, preservando o título mais recente para dar contexto
function chunkText(raw) {
  const chunks = [];
  let heading = '';
  let buf = '';
  const flush = () => {
    const body = buf.trim();
    if (body.length > 20) chunks.push(heading ? `${heading}\n${body}` : body);
    buf = '';
  };
  for (const para of raw.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const m = para.match(/^#{1,6}\s+(.*)/);
    if (m) { flush(); heading = m[1].trim(); }
    if (buf.length + para.length > CHUNK) flush();
    if (para.length > CHUNK * 1.5) {
      for (let i = 0; i < para.length; i += CHUNK - OVERLAP) {
        buf = para.slice(i, i + CHUNK);
        flush();
      }
    } else buf += `${para}\n\n`;
  }
  flush();
  return chunks;
}

async function embed(texts) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  return (await res.json()).embeddings;
}

let embedOk = null; // null = ainda não testado

async function refresh() {
  const files = listFiles();
  const live = new Set(files);
  let dirty = false;
  for (const f of Object.keys(index.files)) if (!live.has(f)) { delete index.files[f]; dirty = true; }
  for (const f of files) {
    const st = fs.statSync(f);
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
    const cur = index.files[f];
    // reindexa se mudou, ou se faltam vetores e agora há modelo de embedding
    if (cur && cur.sig === sig && (embedOk === false || cur.chunks.every((c) => c.vec))) continue;
    const chunks = chunkText(fs.readFileSync(f, 'utf8')).map((text) => ({ text }));
    if (embedOk !== false) {
      try {
        for (let i = 0; i < chunks.length; i += 16) {
          const batch = chunks.slice(i, i + 16);
          const vecs = await embed(batch.map((c) => `search_document: ${c.text}`));
          batch.forEach((c, k) => { c.vec = vecs[k]; });
        }
        embedOk = true;
      } catch {
        embedOk = false;
        chunks.forEach((c) => delete c.vec);
      }
    }
    index.files[f] = { sig, chunks };
    dirty = true;
  }
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
    } catch { /* índice só em memória */ }
  }
}

const tokenize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{2,}/g) || [];

function bm25(all, query) {
  const q = [...new Set(tokenize(query))];
  const docs = all.map((c) => tokenize(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1) || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return s;
  });
}

const cosine = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x * y) || 1);
};

async function search(query, k) {
  await refresh();
  const all = [];
  for (const [file, e] of Object.entries(index.files)) for (const c of e.chunks) all.push({ file, ...c });
  if (!all.length) return { hits: [], mode: 'vazio' };

  const kw = bm25(all, query);
  const rankKw = kw.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  let rankVec = [];
  let mode = 'palavras-chave';
  if (embedOk !== false && all.every((c) => c.vec)) {
    try {
      const [qv] = await embed([`search_query: ${query}`]);
      rankVec = all.map((c, i) => [cosine(qv, c.vec), i]).filter(([s]) => s > 0.35).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
      mode = 'híbrida (semântica + palavras-chave)';
    } catch { /* fica só com palavras-chave */ }
  }
  const score = new Map();
  for (const rank of [rankKw, rankVec]) rank.slice(0, 30).forEach((i, r) => score.set(i, (score.get(i) || 0) + 1 / (60 + r)));
  const hits = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => all[i]);
  return { hits, mode };
}

const server = new McpServer({ name: 'capri-knowledge', version: '1.0.0' });

server.registerTool('search_knowledge', {
  description: 'Busca na base de conhecimento local do usuário (notas, documentos .md/.txt e o guia da própria Capri). Use quando a pergunta puder depender de informações guardadas pelo usuário, de documentação ou de como suas próprias ferramentas funcionam. Devolve os trechos mais relevantes com o arquivo de origem.',
  inputSchema: {
    query: z.string().min(2).describe('O que procurar, em linguagem natural.'),
    max_results: z.number().int().min(1).max(8).optional().describe('Quantidade de trechos. Padrão 4.'),
  },
  annotations: { readOnlyHint: true, title: 'Buscar na base de conhecimento' },
}, async ({ query, max_results }) => {
  try {
    const { hits, mode } = await search(query, max_results ?? 4);
    if (!hits.length) return { content: [{ type: 'text', text: 'Nada relevante encontrado na base de conhecimento.' }] };
    const body = hits.map((h, i) => `[${i + 1}] ${path.basename(h.file)}\n${h.text.trim()}`).join('\n\n---\n\n');
    return { content: [{ type: 'text', text: `Busca ${mode}. Responda usando só o que estes trechos dizem e cite o arquivo.\n\n${body}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true };
  }
});

server.connect(new StdioServerTransport()).then(() => refresh().catch(() => {})).catch((e) => {
  process.stderr.write(`capri-knowledge: ${e.message}\n`);
  process.exit(1);
});
