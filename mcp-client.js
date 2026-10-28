// Cliente MCP da Capri: sobe os servidores MCP, expõe suas ferramentas ao Ollama e roteia as chamadas.
// Servidor embutido: mcp/screen-server.js. Extras em <userData>/mcp.json:
//   { "mcpServers": { "nome": { "command": "npx", "args": ["-y", "pacote"], "env": { } } } }
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CALL_TIMEOUT_MS = 90000;

class McpHub {
  constructor({ dataDir, builtinScript, execPath, appDir }) {
    this.dataDir = dataDir;
    this.appDir = appDir;
    this.builtinScript = builtinScript;
    this.execPath = execPath;
    this.clients = new Map(); // servidor -> Client
    this.tools = new Map(); // nome exposto ao modelo -> { server, name, tool }
    this.ready = null;
  }

  start() {
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }

  _configs() {
    const configs = {
      screen: {
        command: this.execPath,
        args: [this.builtinScript],
        // roda o servidor com o Node embutido no Electron, sem precisar de Node instalado
        env: { ELECTRON_RUN_AS_NODE: '1', CAPRI_SCREENS_DIR: path.join(this.dataDir, 'screens') },
      },
    };
    const kdir = path.join(this.dataDir, 'knowledge');
    try { fs.mkdirSync(kdir, { recursive: true }); } catch { /* sem pasta, só os guias embutidos */ }
    configs.knowledge = {
      command: this.execPath,
      args: [path.join(path.dirname(this.builtinScript), 'knowledge-server.js')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CAPRI_KNOWLEDGE_DIRS: [kdir, path.join(this.appDir, 'knowledge'), path.join(this.appDir, 'skills')].join(path.delimiter),
        CAPRI_INDEX_FILE: path.join(this.dataDir, 'rag-index.json'),
      },
    };    try {
      const extra = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'mcp.json'), 'utf8')).mcpServers || {};
      for (const [name, cfg] of Object.entries(extra)) if (!['screen', 'knowledge'].includes(name) && cfg?.command) configs[name] = cfg;
    } catch { /* sem mcp.json */ }
    return configs;
  }

  async _start() {
    const configs = this._configs();
    await Promise.all(Object.entries(configs).map(async ([server, cfg]) => {
      try {
        const client = new Client({ name: 'capri', version: '1.0.0' });
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args || [],
          env: { ...process.env, ...(cfg.env || {}) },
          stderr: 'ignore',
        });
        await client.connect(transport);
        this.clients.set(server, client);
        const { tools } = await client.listTools();
        for (const tool of tools) this.tools.set(this._exposed(server, tool.name), { server, name: tool.name, tool });
      } catch (e) {
        console.error(`MCP "${server}" indisponível: ${e.message}`);
      }
    }));
  }

  // nomes puros no servidor embutido; os demais ganham prefixo se colidirem
  _exposed(server, name) {
    return this.tools.has(name) ? `${server}_${name}` : name;
  }

  async ollamaTools() {
    await this.start();
    return [...this.tools.entries()].map(([exposed, { tool }]) => ({
      type: 'function',
      function: { name: exposed, description: tool.description || tool.title || exposed, parameters: tool.inputSchema || { type: 'object', properties: {} } },
    }));
  }

  info(name) {
    const e = this.tools.get(name);
    if (!e) return null;
    const a = e.tool.annotations || {};
    return { title: a.title || e.name, readOnly: a.readOnlyHint === true, server: e.server };
  }

  // devolve { text, images[] } a partir do resultado MCP
  async call(name, args) {
    await this.start();
    const e = this.tools.get(name);
    if (!e) return { text: `Erro: ferramenta desconhecida "${name}".`, images: [] };
    const res = await this.clients.get(e.server).callTool(
      { name: e.name, arguments: args && typeof args === 'object' ? args : {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const parts = [];
    const images = [];
    for (const c of res.content || []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') images.push(c.data);
      else if (c.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
    }
    if (res.isError && !parts.length) parts.push('Erro na ferramenta.');
    return { text: parts.join('\n') || '(sem saída)', images };
  }

  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
    this.tools.clear();
    this.ready = null;
  }
}

module.exports = { McpHub };
