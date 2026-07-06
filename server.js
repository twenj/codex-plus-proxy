require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const conversationSessions = new Map();
const CONTEXT_EXPIRE_TIME = parseInt(process.env.CONTEXT_EXPIRE_TIME) || 3600000;

const app = express();
const PORT = process.env.PORT || 3002;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'codex-latest';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_WEB_INTERFACE = process.env.USE_WEB_INTERFACE === 'true';
const USE_CLI = process.env.USE_CLI === 'true';
const USE_APP_SERVER = process.env.USE_APP_SERVER === 'true' || USE_CLI;

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'danger-full-access';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || '';
const PROCESS_TIMEOUT = parseInt(process.env.PROCESS_TIMEOUT) || 600000;
const SSE_HEARTBEAT_INTERVAL = parseInt(process.env.SSE_HEARTBEAT_INTERVAL) || 15000;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 3;
const CODEX_LEAN_MODE = process.env.CODEX_LEAN_MODE === 'true';
const DEFAULT_REASONING_EFFORT = process.env.DEFAULT_REASONING_EFFORT || '';
const PROXY_BROWSER_CONFIG = CODEX_LEAN_MODE
  ? [
      '--disable', 'plugins',
      '--disable', 'browser_use',
      '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.playwright.enabled=false',
    ]
  : [];
const APPROVAL_POLICY = process.env.APPROVAL_POLICY || 'never';

// XML 检测配置
const XML_BUFFER_MAX_LENGTH = 100; // XML 标签检测前的最大缓冲长度
const XML_BUFFER_ABSOLUTE_MAX = 10000; // XML 缓冲区绝对最大长度，防止内存溢出
const XML_TAG_PATTERN = /<[a-z][a-z0-9_]*[\s/>]/i; // 检测 XML 标签的正则表达式
const MAX_STDERR_BUFFER = 64 * 1024;

// 日志配置
const DEBUG_MODE = process.env.DEBUG === 'true';

if (!SANDBOX_MODES.includes(CODEX_SANDBOX)) {
  console.error(`Error: CODEX_SANDBOX must be one of: ${SANDBOX_MODES.join(', ')}`);
  process.exit(1);
}

if (!USE_WEB_INTERFACE && !USE_CLI && !OPENAI_API_KEY) {
  console.error('Error: Either OPENAI_API_KEY is required, or USE_WEB_INTERFACE=true, or USE_CLI=true must be set in .env file');
  process.exit(1);
}

class AppServerClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.buffer = '';
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.initPromise = null;
    this.stderr = '';
  }

  async start() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().catch((err) => {
      this.initialized = false;
      this.initPromise = null;
      if (this.child && !this.child.killed) this.child.kill('SIGTERM');
      this.child = null;
      throw err;
    });
    return this.initPromise;
  }

  async _doInit() {
    const args = ['app-server', '--stdio', ...PROXY_BROWSER_CONFIG];
    const env = { ...process.env };
    if (!env.CODEX_HOME) {
      const stateDir = path.join(os.tmpdir(), 'codex-proxy-state');
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }
      const authSrc = path.join(process.env.HOME || os.homedir(), '.codex', 'auth.json');
      const authDst = path.join(stateDir, 'auth.json');
      if (fs.existsSync(authSrc) && !fs.existsSync(authDst)) {
        try {
          fs.copyFileSync(authSrc, authDst);
        } catch (e) {
          console.warn('Failed to copy auth.json:', e.message);
        }
      }
      const configSrc = path.join(process.env.HOME || os.homedir(), '.codex', 'config.toml');
      const configDst = path.join(stateDir, 'config.toml');
      if (fs.existsSync(configSrc) && !fs.existsSync(configDst)) {
        try {
          fs.copyFileSync(configSrc, configDst);
        } catch (e) {
          console.warn('Failed to copy config.toml:', e.message);
        }
      }
      env.CODEX_HOME = stateDir;
    }
    this.child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child.stdout.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this._handleMessage(msg);
        } catch (e) {
          console.warn('Failed to parse app-server message:', trimmed.slice(0, 200));
        }
      }
    });

    this.child.stderr.on('data', (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > MAX_STDERR_BUFFER) {
        this.stderr = this.stderr.slice(-MAX_STDERR_BUFFER);
      }
    });

    this.child.on('error', (err) => {
      console.error('App Server process error:', err.message);
      this._rejectAllPending(err);
      this.initialized = false;
      this.initPromise = null;
    });

    this.child.on('close', (code, signal) => {
      console.warn(`App Server process exited - code: ${code}, signal: ${signal}`);
      if (this.stderr) {
        console.warn('App Server stderr (last 500 chars):', this.stderr.slice(-500));
      }
      this._rejectAllPending(new Error(`App Server exited: code=${code}, signal=${signal}`));
      this.initialized = false;
      this.initPromise = null;
    });

    const initResult = await this.request('initialize', {
      clientInfo: { name: 'codex-proxy', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });

    this.notify('initialized', {});
    this.initialized = true;
    console.log('App Server initialized:', initResult.userAgent);
    return initResult;
  }

  _handleMessage(msg) {
    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method) {
        this.emit('serverRequest', msg.id, msg.method, msg.params || {});
      }
    } else {
      if (msg.method) {
        this.emit('notification', msg.method, msg.params || {});
        if (msg.method !== 'error') {
          this.emit(msg.method, msg.params || {});
        } else {
          console.warn('App Server error notification:', msg.params?.error?.message || JSON.stringify(msg.params).slice(0, 200));
        }
      }
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  respond(id, result) {
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  async threadStart({ model, cwd, sandbox, ephemeral = false }) {
    const params = { model, cwd, sandbox, ephemeral };
    const result = await this.request('thread/start', params);
    return result.thread;
  }

  async threadResume(threadId) {
    const result = await this.request('thread/resume', { threadId });
    return result.thread;
  }

  async turnStart({ threadId, input, model, effort }) {
    const params = { threadId, input };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    const result = await this.request('turn/start', params);
    return result.turn;
  }

  async turnInterrupt(threadId) {
    try {
      await this.request('turn/interrupt', { threadId });
    } catch (e) {
    }
  }

  shutdown() {
    if (this.child) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}

const appServer = USE_APP_SERVER && USE_CLI ? new AppServerClient() : null;

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let finished = false;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    finished = true;
    console.log(`[${requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  res.on('close', () => {
    if (!finished) {
      console.warn(`[${requestId}] ${req.method} ${req.originalUrl} client-closed ${Date.now() - startedAt}ms`);
    }
  });
  next();
});
app.use(cors());
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  if (typeof res.compress === 'function') {
    res.compress = false;
  }
  res.flushHeaders();
}

function writeSSE(res, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${data}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

function startSSEHeartbeat(res) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': heartbeat\n\n');
    if (typeof res.flush === 'function') res.flush();
  }, SSE_HEARTBEAT_INTERVAL);
  timer.unref();
  return timer;
}

let activeCodexProcesses = 0;
const codexWaitQueue = [];

function acquireCodexSlot(req) {
  if (activeCodexProcesses < MAX_CONCURRENT_REQUESTS) {
    activeCodexProcesses++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    const onAborted = () => {
      const index = codexWaitQueue.indexOf(entry);
      if (index !== -1) {
        codexWaitQueue.splice(index, 1);
        reject(new Error('Client disconnected while waiting for an available Codex slot'));
      }
    };
    entry.onDequeued = () => req.removeListener('aborted', onAborted);
    req.once('aborted', onAborted);
    codexWaitQueue.push(entry);
  });
}

function releaseCodexSlot() {
  activeCodexProcesses--;
  const next = codexWaitQueue.shift();
  if (next) {
    activeCodexProcesses++;
    next.onDequeued();
    next.resolve();
  }
}

const AVAILABLE_MODELS = [
  { id: 'my-gpt-5.5', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'my-gpt-5.4', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'my-gpt-5.4-mini', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'my-gpt-5', object: 'model', created: 1718000000, owned_by: 'openai' },
];

function mapModel(model) {
  const modelMap = {
    'codex-latest': 'gpt-5.5',
    'codex-base': 'gpt-5.4',
    'my-gpt-5.5': 'gpt-5.5',
    'my-gpt-5.4': 'gpt-5.4',
    'my-gpt-5.4-mini': 'gpt-5.4-mini',
    'my-gpt-5': 'gpt-5',
    'gpt-5.5': 'gpt-5.5',
    'gpt-5.4': 'gpt-5.4',
    'gpt-5.4-mini': 'gpt-5.4-mini',
    'gpt-5': 'gpt-5',
  };
  return modelMap[model] || model || 'gpt-5.5';
}

function displayModel(internalModel, requestModel) {
  if (requestModel && requestModel.startsWith('my-')) return requestModel;
  const displayMap = {
    'gpt-5.5': 'my-gpt-5.5',
    'gpt-5.4': 'my-gpt-5.4',
    'gpt-5.4-mini': 'my-gpt-5.4-mini',
    'gpt-5': 'my-gpt-5',
  };
  return displayMap[internalModel] || internalModel;
}

function contentToString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'tool_result' || part.type === 'tool_response') {
          return contentToString(part.content ?? part.output ?? part.result);
        }
        if (typeof part.content === 'string') return part.content;
        if (typeof part.output === 'string') return part.output;
        if (typeof part.result === 'string') return part.result;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function isRooCodeRequest(req, messages, tools) {
  const clientHint = String(req.headers['x-codex-client'] || req.headers['user-agent'] || '').toLowerCase();
  if (clientHint.includes('roo')) return true;

  const systemText = (Array.isArray(messages) ? messages : [])
    .filter(message => message.role === 'system')
    .map(message => contentToString(message.content))
    .join('\n')
    .toLowerCase();
  if (systemText.includes('roo code') || systemText.includes('ask_followup_question')) return true;

  return Array.isArray(tools) && tools.some(tool => {
    const name = tool?.function?.name || tool?.name || '';
    return String(name).toLowerCase() === 'ask_followup_question';
  });
}

function findInteractiveTool(tools) {
  if (!Array.isArray(tools)) return null;
  const exactNames = [
    'request_user_input',
    'ask_user_question',
    'ask_questions',
    'ask_question',
    'ask_followup_question',
    'AskUserQuestion',
  ];
  for (const name of exactNames) {
    const match = tools.find(tool => String(tool?.function?.name || tool?.name || '').toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return tools.find(tool => /(?:ask|question|feedback|user_input)/i.test(tool?.function?.name || tool?.name || '')) || null;
}

function buildOptionValue(schema, text, index) {
  if (!schema || schema.type === 'string') return text;
  const properties = schema.properties || {};
  const result = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (/^(?:label|title|text|name|value)$/i.test(key)) result[key] = text;
    else if (/^(?:description|detail|subtitle)$/i.test(key)) result[key] = text;
    else if (/^(?:id|key)$/i.test(key)) result[key] = `option_${index + 1}`;
    else if (propertySchema?.type === 'string' && (schema.required || []).includes(key)) result[key] = text;
    else if (propertySchema?.type === 'boolean' && (schema.required || []).includes(key)) result[key] = false;
    else if ((schema.required || []).includes(key)) result[key] = null;
  }
  return result;
}

function buildInteractiveArguments(tool, question, suggestions) {
  const parameters = tool?.function?.parameters || tool?.input_schema || tool?.parameters || {};
  const properties = parameters.properties || {};
  const args = {};

  const buildOptions = propertySchema => {
    const itemSchema = propertySchema?.items || { type: 'string' };
    return suggestions.map((text, index) => buildOptionValue(itemSchema, text, index));
  };

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (/^(?:question|prompt|message)$/i.test(key)) {
      args[key] = question;
    } else if (/^(?:title|header)$/i.test(key)) {
      args[key] = '提问';
    } else if (/^(?:options|choices|suggestions|follow_up)$/i.test(key) && propertySchema?.type === 'array') {
      args[key] = buildOptions(propertySchema);
    } else if (/^questions$/i.test(key) && propertySchema?.type === 'array') {
      const itemSchema = propertySchema.items || {};
      const item = {};
      for (const [itemKey, itemProperty] of Object.entries(itemSchema.properties || {})) {
        if (/^(?:question|prompt|message)$/i.test(itemKey)) item[itemKey] = question;
        else if (/^(?:title|header)$/i.test(itemKey)) item[itemKey] = '提问';
        else if (/^(?:options|choices|suggestions)$/i.test(itemKey) && itemProperty?.type === 'array') {
          item[itemKey] = buildOptions(itemProperty);
        } else if ((itemSchema.required || []).includes(itemKey)) {
          item[itemKey] = itemProperty?.type === 'boolean' ? false : question;
        }
      }
      args[key] = [item];
    } else if ((parameters.required || []).includes(key)) {
      if (propertySchema?.type === 'boolean') args[key] = false;
      else if (propertySchema?.type === 'array') args[key] = [];
      else args[key] = question;
    }
  }
  return args;
}

function decodeWorkdirHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value));
  } catch (e) {
    return String(value);
  }
}

function inferRooWorkdir(messages) {
  const text = (Array.isArray(messages) ? messages : [])
    .map(message => contentToString(message.content))
    .join('\n');

  const patterns = [
    /<cwd>([^<]+)<\/cwd>/i,
    /Current (?:Working|Workspace) Directory\s*\(([^)\n]+)\)/i,
    /(?:cwd|working directory)\s*[:：]\s*([^\n<]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1]
        .trim()
        .replace(/&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/^[\s'"`]+|[\s'"`]+$/g, '');
    }
  }
  return '';
}

const CLIENT_INTERACTION_PROMPT = `
You are serving an IDE client that supports a native interactive-question card. When essential information is missing and the user must choose or clarify, do not guess and do not use an internal user-input tool. End the turn with exactly one ask_followup_question XML block, without Markdown fences or explanatory text:
<ask_followup_question>
<question>Write the concise question here</question>
<follow_up>
<suggest>First concrete option</suggest>
<suggest>Second concrete option</suggest>
</follow_up>
</ask_followup_question>
Use two to four useful suggestions. Only use this block when an answer is genuinely required; otherwise complete the task normally.`;

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
}

function createClientToolCall(content, rooCodeRequest, interactiveTool) {
  const text = String(content || '').trim();
  const askMatch = text.match(/<ask_followup_question>[\s\S]*?<question>([\s\S]*?)<\/question>[\s\S]*?<follow_up>([\s\S]*?)<\/follow_up>[\s\S]*?<\/ask_followup_question>/i);

  let name;
  let args;
  if (askMatch) {
    const suggestions = [...askMatch[2].matchAll(/<suggest>([\s\S]*?)<\/suggest>/gi)]
      .map(match => decodeXmlText(match[1]))
      .filter(Boolean);
    const question = decodeXmlText(askMatch[1]);
    name = interactiveTool?.function?.name || interactiveTool?.name || 'ask_followup_question';
    args = interactiveTool
      ? buildInteractiveArguments(interactiveTool, question, suggestions)
      : { question, follow_up: suggestions.map(text => ({ text, mode: null })) };
  } else if (rooCodeRequest) {
    const completionMatch = text.match(/<attempt_completion>[\s\S]*?<result>([\s\S]*?)<\/result>[\s\S]*?<\/attempt_completion>/i);
    name = 'attempt_completion';
    args = { result: decodeXmlText(completionMatch ? completionMatch[1] : text) };
  } else {
    return null;
  }

  return {
    id: `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function hasAnsweredInteractiveTool(messages, interactiveTool) {
  const toolName = String(interactiveTool?.function?.name || interactiveTool?.name || '').toLowerCase();
  if (!toolName || !Array.isArray(messages)) return false;
  const recentMessages = messages.slice(-8);
  const matchingCallIds = new Set();
  for (const message of recentMessages) {
    for (const call of message?.tool_calls || []) {
      if (String(call?.function?.name || '').toLowerCase() === toolName && call?.id) {
        matchingCallIds.add(call.id);
      }
    }
  }
  return recentMessages.some(message => {
    if (message?.role !== 'tool') return false;
    const responseName = String(message.name || '').toLowerCase();
    return responseName === toolName || (message.tool_call_id && matchingCallIds.has(message.tool_call_id));
  });
}

function messagesToAppServerInput(messages, images, userOnly = false) {
  const input = [];
  let imageIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (userOnly && msg.role !== 'user') continue;

    const textContent = contentToString(msg.content);

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          input.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const img = images[imageIndex++];
          if (img) input.push({ type: 'localImage', path: img.path });
        }
      }
    } else if (msg.role === 'user') {
      input.push({ type: 'text', text: textContent });
    } else if (msg.role === 'tool') {
      input.push({ type: 'text', text: `Tool result${msg.name ? ` (${msg.name})` : ''}: ${textContent}` });
    }
  }

  return input;
}

function extractAndSaveImages(messages) {
  const images = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-'));

  let imageIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url) {
          const url = part.image_url.url;
          let imagePath = null;
          let imageExt = 'png';

          if (url.startsWith('data:image/')) {
            const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) {
              imageExt = match[1] === 'jpeg' ? 'jpg' : match[1];
              const base64Data = match[2];
              imagePath = path.join(tempDir, `image_${imageIndex}.${imageExt}`);
              fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
            }
          }

          images.push(imagePath ? { path: imagePath, index: imageIndex } : null);
          imageIndex++;
        }
      }
    }
  }

  return { images, tempDir };
}

function cleanupTempDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to cleanup temp dir:', e.message);
  }
}

function getConversationSession(conversationId) {
  if (!conversationId) return null;

  const session = conversationSessions.get(conversationId);
  if (!session) return null;

  if (Date.now() - session.lastUpdated > CONTEXT_EXPIRE_TIME) {
    conversationSessions.delete(conversationId);
    return null;
  }

  return session;
}

function saveConversationSession(conversationId, threadId, sentCount) {
  if (!conversationId || !threadId) return;

  conversationSessions.set(conversationId, {
    threadId,
    sentCount,
    lastUpdated: Date.now(),
  });
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [conversationId, session] of conversationSessions) {
    if (now - session.lastUpdated > CONTEXT_EXPIRE_TIME) {
      conversationSessions.delete(conversationId);
    }
  }
}

setInterval(cleanupExpiredSessions, Math.max(CONTEXT_EXPIRE_TIME / 2, 60000)).unref();

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const {
      messages,
      model,
      stream = true,
      temperature,
      max_tokens,
      reasoning_effort,
      tools,
      conversation_id,
      sandbox,
      workdir,
    } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'messages must be a non-empty array',
          type: 'invalid_request_error',
        },
      });
    }

    const cliModel = mapModel(model);
    const reasoningEffort = reasoning_effort || DEFAULT_REASONING_EFFORT;
    const rooCodeRequest = isRooCodeRequest(req, messages, tools);
    const interactiveTool = findInteractiveTool(tools);
    const interactiveClientRequest = rooCodeRequest || Boolean(interactiveTool);
    const interactiveToolAnswered = hasAnsweredInteractiveTool(messages, interactiveTool);
    if (DEBUG_MODE && interactiveTool) {
      const toolName = interactiveTool?.function?.name || interactiveTool?.name;
      console.log(`[interactive-tool] ${toolName} answered=${interactiveToolAnswered}`);
    }

    const requestSandbox = sandbox || req.headers['x-codex-sandbox'] || CODEX_SANDBOX;
    const headerWorkdir = decodeWorkdirHeader(req.headers['x-codex-workdir']);
    const inferredWorkdir = rooCodeRequest ? inferRooWorkdir(messages) : '';
    const requestWorkdir = workdir || headerWorkdir || inferredWorkdir || CODEX_WORKDIR;

    if (!SANDBOX_MODES.includes(requestSandbox)) {
      return res.status(400).json({
        error: {
          message: `Invalid sandbox mode "${requestSandbox}". Must be one of: ${SANDBOX_MODES.join(', ')}`,
          type: 'invalid_request_error',
        },
      });
    }

    if (requestWorkdir && !fs.existsSync(requestWorkdir)) {
      return res.status(400).json({
        error: {
          message: `Working directory does not exist: ${requestWorkdir}`,
          type: 'invalid_request_error',
        },
      });
    }

    const conversationSession = conversation_id ? getConversationSession(conversation_id) : null;
    const resumeThreadId = conversationSession ? conversationSession.threadId : null;
    const promptMessages = conversationSession ? messages.slice(conversationSession.sentCount) : messages;

    if (conversationSession && promptMessages.filter(m => m.role === 'user' || m.role === 'assistant').length === 0) {
      return res.status(400).json({
        error: {
          message: 'No new messages for this conversation_id since the last turn.',
          type: 'invalid_request_error',
        },
      });
    }

    const { images, tempDir } = extractAndSaveImages(promptMessages);

    if (USE_CLI && appServer) {
      try {
        await appServer.start();
        await acquireCodexSlot(req);
      } catch (err) {
        cleanupTempDir(tempDir);
        throw err;
      }

      let threadId = null;
      let turnCompleted = false;
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedPromptTokens = 0;
      let reasoningTokens = 0;
      let fullText = '';
      let streamedText = '';
      let timedOut = false;
      const chatId = 'chatcmpl-' + Date.now();
      const createdTime = Math.floor(Date.now() / 1000);
      let resolveTurn = null;

      const timeout = setTimeout(() => {
        timedOut = true;
        console.error('Turn timed out');
        if (threadId) appServer.turnInterrupt(threadId);
        if (resolveTurn) resolveTurn();
      }, PROCESS_TIMEOUT);

      function sendChunk(content) {
        if (!content || !stream) return;
        streamedText += content;
        const chunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model: displayModel(cliModel, model),
          choices: [
            {
              index: 0,
              delta: { content: content },
              finish_reason: null,
            },
          ],
        };
        writeSSE(res, JSON.stringify(chunk));
        // 强制刷新缓冲区
        if (res.socket && res.socket.write) {
          res.socket.uncork();
        }
      }

      let hasToolCall = false; // 追踪是否实际生成了工具调用
      let xmlBuffer = ''; // 缓冲 XML 内容
      let possibleXmlStart = false; // 可能正在生成 XML 标签

      // 检测 XML 工具调用标签
      function detectXmlToolCall() {
        if (!interactiveClientRequest || hasToolCall || interactiveToolAnswered) {
          return false;
        }

        // 防止缓冲区无限增长
        if (xmlBuffer.length > XML_BUFFER_ABSOLUTE_MAX) {
          console.warn(`[XML-DETECT] Buffer exceeded max size (${XML_BUFFER_ABSOLUTE_MAX}), resetting`);
          xmlBuffer = xmlBuffer.slice(-XML_BUFFER_MAX_LENGTH);
          possibleXmlStart = false;
          return false;
        }

        // 检测 XML 标签
        if (XML_TAG_PATTERN.test(xmlBuffer)) {
          hasToolCall = true;
          possibleXmlStart = false;
          if (DEBUG_MODE) {
            console.log(`[TOOL-CALL] Detected XML tool call: ${xmlBuffer.slice(0, 50)}...`);
          }
          return true;
        }

        // 如果缓冲区很长但还没检测到完整的 XML 标签，说明不是 XML（误判）
        if (possibleXmlStart && xmlBuffer.length > XML_BUFFER_MAX_LENGTH) {
          possibleXmlStart = false;
          sendChunk(xmlBuffer);
          xmlBuffer = '';
          return false;
        }

        return false;
      }

      function onNotification(method, params) {
        if (params.threadId && threadId && params.threadId !== threadId) return;

        // 检测工具调用开始（真正的 tool call）
        if (method === 'item/toolCall/started') {
          hasToolCall = true;
          if (DEBUG_MODE) {
            console.log('[TOOL-CALL] Detected via item/toolCall/started');
          }
        }

        if (method === 'item/agentMessage/delta' && params.delta) {
          fullText += params.delta;
          xmlBuffer += params.delta;
          
          // 检测 XML 工具调用标签（如果有交互工具且还没检测到工具调用）
          if (interactiveClientRequest && !hasToolCall && !interactiveToolAnswered) {
            // 如果看到 '<' 字符，标记可能正在生成 XML
            if (params.delta.includes('<')) {
              possibleXmlStart = true;
            }
            
            // 执行 XML 检测
            detectXmlToolCall();
          }
          
          // 只有在实际生成了工具调用或可能正在生成 XML 时才缓冲，否则立即流式发送
          const shouldBuffer = (hasToolCall || possibleXmlStart) && interactiveClientRequest && !interactiveToolAnswered;
          if (!shouldBuffer) {
            sendChunk(params.delta);
          }
        }

        if (method === 'item/completed' && params.item && params.item.type === 'agentMessage') {
          const text = params.item.text || '';
          if (text && text.startsWith(fullText)) {
            const remaining = text.slice(fullText.length);
            if (remaining) {
              // 如果没有交互工具，或者交互工具已经回答过，就发送剩余内容
              if (!interactiveClientRequest || interactiveToolAnswered) {
                sendChunk(remaining);
              }
              fullText = text;
            }
          } else if (text && !fullText.endsWith(text)) {
            // 一个 turn 可能包含多个 agentMessage。completed 中的 text 只属于当前
            // item，不能用它覆盖此前 delta 的累计文本。
            fullText += text;
            if (!interactiveClientRequest || interactiveToolAnswered) {
              sendChunk(text);
            }
          }
        }

        if (method === 'thread/tokenUsage/updated' && params.tokenUsage) {
          const usage = params.tokenUsage.last || params.tokenUsage.total || {};
          promptTokens = usage.inputTokens || 0;
          completionTokens = usage.outputTokens || 0;
          cachedPromptTokens = usage.cachedInputTokens || 0;
          reasoningTokens = usage.reasoningOutputTokens || 0;
        }

        if (method === 'turn/completed') {
          turnCompleted = true;
          if (resolveTurn) resolveTurn();
        }
      }

      function onServerRequest(id, method, params) {
        if (params.threadId && threadId && params.threadId !== threadId) return;

        if (method === 'item/permissions/requestApproval') {
          // Codex CLI 0.142+ uses a distinct response schema for permission-profile
          // requests. Echo the requested profile only when this proxy is configured
          // to auto-approve; otherwise grant no additional permissions for this turn.
          const permissions = (APPROVAL_POLICY === 'never' || requestSandbox === 'danger-full-access')
            ? (params.permissions || {})
            : {};
          appServer.respond(id, { permissions, scope: 'turn' });
        } else if (method.includes('/requestApproval') || method.includes('/approval')) {
          if (APPROVAL_POLICY === 'never' || requestSandbox === 'danger-full-access') {
            appServer.respond(id, { decision: 'accept' });
          } else {
            appServer.respond(id, { decision: 'cancel' });
          }
        } else {
          try { appServer.respond(id, {}); } catch (e) {}
        }
      }

      const waitForTurn = () => new Promise((resolve) => {
        resolveTurn = resolve;
      });

      if (stream) {
        setupSSE(res);
        const heartbeat = startSSEHeartbeat(res);

        // 发送初始 role chunk（OpenAI 标准格式）
        writeSSE(res, JSON.stringify({
          id: chatId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model: displayModel(cliModel, model),
          choices: [{
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          }],
        }));

        res.on('close', () => {
          if (threadId && !turnCompleted) {
            appServer.turnInterrupt(threadId);
          }
          if (resolveTurn) resolveTurn();
        });

        try {
          if (resumeThreadId) {
            threadId = resumeThreadId;
            await appServer.threadResume(threadId);
          } else {
            const thread = await appServer.threadStart({
              model: cliModel,
              cwd: requestWorkdir || process.cwd(),
              sandbox: requestSandbox,
              ephemeral: !conversation_id,
            });
            threadId = thread.id;
          }

          // threadId 必须先确定，避免并发请求在启动窗口接收其他线程的事件。
          appServer.on('notification', onNotification);
          appServer.on('serverRequest', onServerRequest);

          let systemPrompt = promptMessages.filter(m => m.role === 'system').map(m => contentToString(m.content)).join('\n\n');
          if (interactiveClientRequest) {
            systemPrompt = [systemPrompt, CLIENT_INTERACTION_PROMPT].filter(Boolean).join('\n\n');
          }

          const input = [];
          if (systemPrompt) {
            input.push({ type: 'text', text: systemPrompt });
          }
          const userInput = messagesToAppServerInput(promptMessages, images, !!resumeThreadId);
          input.push(...userInput);

          // 先安装完成回调，避免极短 turn 在 turn/start 返回前已经 completed。
          const turnCompletion = waitForTurn();
          await appServer.turnStart({ threadId, input, model: cliModel, effort: reasoningEffort });
          await turnCompletion;

          if (res.writableEnded) return;

          if (timedOut) {
            const errorChunk = {
              error: {
                message: `Request timed out after ${PROCESS_TIMEOUT}ms`,
                type: 'api_error',
              },
            };
            writeSSE(res, JSON.stringify(errorChunk));
            res.end();
            return;
          }

          if (conversation_id) {
            saveConversationSession(conversation_id, threadId, messages.length + 1);
          }

          const rooToolCall = interactiveClientRequest
            ? createClientToolCall(fullText, rooCodeRequest, interactiveTool)
            : null;

          // 只有确认已发送内容是完整文本前缀时才补发尾部。不能只按字符数切片：
          // 多个 agentMessage 或 completed 事件会让两者不再指向同一段文本。
          const remainingText = fullText.startsWith(streamedText)
            ? fullText.slice(streamedText.length)
            : (streamedText ? '' : fullText);
          if (interactiveClientRequest && !interactiveToolAnswered && !rooToolCall && remainingText) {
            sendChunk(remainingText);
          }

          if (rooToolCall) {
            writeSSE(res, JSON.stringify({
              id: chatId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model: displayModel(cliModel, model),
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, ...rooToolCall }] },
                finish_reason: null,
              }],
            }));
          }

          const finalChunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model: displayModel(cliModel, model),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: rooToolCall ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              prompt_tokens_details: { cached_tokens: cachedPromptTokens },
              completion_tokens_details: { reasoning_tokens: reasoningTokens },
            },
          };
          writeSSE(res, JSON.stringify(finalChunk));
          writeSSE(res, '[DONE]');
          res.end();
        } catch (err) {
          console.error('App Server stream error:', err.message);
          if (!res.writableEnded) {
            const errorChunk = {
              error: {
                message: err.message || 'Internal server error',
                type: 'api_error',
              },
            };
            writeSSE(res, JSON.stringify(errorChunk));
            res.end();
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          appServer.removeListener('notification', onNotification);
          appServer.removeListener('serverRequest', onServerRequest);
          cleanupTempDir(tempDir);
          releaseCodexSlot();
        }
      } else {
        try {
          if (resumeThreadId) {
            threadId = resumeThreadId;
            await appServer.threadResume(threadId);
          } else {
            const thread = await appServer.threadStart({
              model: cliModel,
              cwd: requestWorkdir || process.cwd(),
              sandbox: requestSandbox,
              ephemeral: !conversation_id,
            });
            threadId = thread.id;
          }

          appServer.on('notification', onNotification);
          appServer.on('serverRequest', onServerRequest);

          let systemPrompt = promptMessages.filter(m => m.role === 'system').map(m => contentToString(m.content)).join('\n\n');
          if (interactiveClientRequest) {
            systemPrompt = [systemPrompt, CLIENT_INTERACTION_PROMPT].filter(Boolean).join('\n\n');
          }

          const input = [];
          if (systemPrompt) {
            input.push({ type: 'text', text: systemPrompt });
          }
          const userInput = messagesToAppServerInput(promptMessages, images, !!resumeThreadId);
          input.push(...userInput);

          const turnCompletion = waitForTurn();
          await appServer.turnStart({ threadId, input, model: cliModel, effort: reasoningEffort });
          await turnCompletion;

          if (timedOut) {
            return res.status(500).json({
              error: {
                message: `Request timed out after ${PROCESS_TIMEOUT}ms`,
                type: 'api_error',
              },
            });
          }

          if (conversation_id) {
            saveConversationSession(conversation_id, threadId, messages.length + 1);
          }

          const rooToolCall = interactiveClientRequest
            ? createClientToolCall(fullText, rooCodeRequest, interactiveTool)
            : null;

          const openAIResponse = {
            id: chatId,
            object: 'chat.completion',
            created: createdTime,
            model: displayModel(cliModel, model),
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: rooToolCall ? null : fullText,
                  ...(rooToolCall ? { tool_calls: [rooToolCall] } : {}),
                },
                finish_reason: rooToolCall ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              prompt_tokens_details: { cached_tokens: cachedPromptTokens },
              completion_tokens_details: { reasoning_tokens: reasoningTokens },
            },
          };

          res.json(openAIResponse);
        } catch (err) {
          console.error('App Server error:', err.message);
          if (!res.writableEnded) {
            res.status(500).json({
              error: {
                message: err.message || 'Internal server error',
                type: 'api_error',
              },
            });
          }
        } finally {
          clearTimeout(timeout);
          appServer.removeListener('notification', onNotification);
          appServer.removeListener('serverRequest', onServerRequest);
          cleanupTempDir(tempDir);
          releaseCodexSlot();
        }
      }

      return;
    }

    if (USE_WEB_INTERFACE) {
      const replyText = '这是来自网页版的响应，需要进一步实现具体逻辑。';
      
      if (stream) {
        setupSSE(res);
        
        const chunkSize = 10;
        for (let i = 0; i < replyText.length; i += chunkSize) {
          const chunkText = replyText.slice(i, i + chunkSize);
          const chunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: displayModel(cliModel, model),
            choices: [
              {
                index: 0,
                delta: { content: chunkText },
                finish_reason: null,
              },
            ],
          };
          writeSSE(res, JSON.stringify(chunk));
        }
        
        const finalChunk = {
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: displayModel(cliModel, model),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };
        writeSSE(res, JSON.stringify(finalChunk));
        writeSSE(res, '[DONE]');
        res.end();
      } else {
        res.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: displayModel(cliModel, model),
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: replyText,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
      }
      
      cleanupTempDir(tempDir);
      return;
    }

    const requestBody = {
      model: displayModel(cliModel, model),
      messages: messages,
      temperature: temperature,
      max_tokens: max_tokens,
      tools: tools,
      stream: stream,
    };
    
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      
      res.on('finish', () => {
        cleanupTempDir(tempDir);
      });
    });
    
    proxyReq.on('error', (error) => {
      console.error('Proxy error:', error);
      res.status(500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'api_error',
        },
      });
      
      cleanupTempDir(tempDir);
    });
    
    proxyReq.write(JSON.stringify(requestBody));
    proxyReq.end();
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
      },
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Codex proxy server is running',
    default_model: displayModel(mapModel(DEFAULT_MODEL)),
    available_models: AVAILABLE_MODELS.map(model => model.id),
    sandbox: CODEX_SANDBOX,
    workdir: CODEX_WORKDIR || process.cwd(),
    app_server: USE_APP_SERVER && appServer ? appServer.initialized : false,
    lean_mode: CODEX_LEAN_MODE,
    default_reasoning_effort: DEFAULT_REASONING_EFFORT || null,
    active_processes: activeCodexProcesses,
    queued_requests: codexWaitQueue.length,
  });
});

function startHttpServer() {
  const server = app.listen(PORT, () => {
    console.log(`Codex proxy server running on http://localhost:${PORT}`);
    console.log(`Default model: ${DEFAULT_MODEL}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    if (USE_APP_SERVER && appServer) {
      console.log('App Server mode: enabled (lazy initialized on first request)');
    }
  });

  const shutdown = signal => {
    console.log(`${signal} received, shutting down...`);
    if (appServer) appServer.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) {
  startHttpServer();
}

module.exports = {
  AppServerClient,
  cleanupTempDir,
  extractAndSaveImages,
  messagesToAppServerInput,
  startHttpServer,
};
