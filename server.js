require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const conversationContext = new Map();
const CONTEXT_EXPIRE_TIME = parseInt(process.env.CONTEXT_EXPIRE_TIME) || 3600000;

const app = express();
const PORT = process.env.PORT || 3002;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'codex-latest';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_WEB_INTERFACE = process.env.USE_WEB_INTERFACE === 'true';
const USE_CLI = process.env.USE_CLI === 'true';
// 沙箱模式：read-only（只读）| workspace-write（可写工作区）| danger-full-access（无限制）
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'danger-full-access';
// Codex 的工作目录（-C 参数），不设置则使用代理进程自身的 cwd
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || '';
// 子进程超时时间（毫秒），默认5分钟
const PROCESS_TIMEOUT = parseInt(process.env.PROCESS_TIMEOUT) || 120000;
const SSE_HEARTBEAT_INTERVAL = parseInt(process.env.SSE_HEARTBEAT_INTERVAL) || 15000;

if (!SANDBOX_MODES.includes(CODEX_SANDBOX)) {
  console.error(`Error: CODEX_SANDBOX must be one of: ${SANDBOX_MODES.join(', ')}`);
  process.exit(1);
}

if (!USE_WEB_INTERFACE && !USE_CLI && !OPENAI_API_KEY) {
  console.error('Error: Either OPENAI_API_KEY is required, or USE_WEB_INTERFACE=true, or USE_CLI=true must be set in .env file');
  process.exit(1);
}

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // compression 会缓冲较小的 SSE 数据块，导致客户端看起来一直没有响应。
  res.setHeader('Content-Encoding', 'identity');
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

const AVAILABLE_MODELS = [
  { id: 'gpt-5.5', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'gpt-5.4', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'gpt-5.4-mini', object: 'model', created: 1718000000, owned_by: 'openai' },
  { id: 'gpt-5', object: 'model', created: 1718000000, owned_by: 'openai' },
];

function mapModel(model) {
  const modelMap = {
    'codex-latest': 'gpt-5.5',
    'codex-base': 'gpt-5.4',
    'gpt-5.5': 'gpt-5.5',
    'gpt-5.4': 'gpt-5.4',
    'gpt-5.4-mini': 'gpt-5.4-mini',
    'gpt-5': 'gpt-5',
  };
  return modelMap[model] || model || 'gpt-5.5';
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
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function buildPrompt(messages, images) {
  let prompt = '';
  let imageIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    const textContent = contentToString(msg.content);
    let msgContent = textContent;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageParts = msg.content.filter(p => p.type === 'image_url');
      if (imageParts.length > 0) {
        const imgDescs = [];
        for (let i = 0; i < imageParts.length; i++) {
          const img = images[imageIndex];
          if (img) {
            imgDescs.push(`[图片 ${imageIndex + 1}: 请读取文件 ${img.path}]`);
            imageIndex++;
          }
        }
        if (imgDescs.length > 0) {
          msgContent = imgDescs.join('\n') + '\n\n' + textContent;
        }
      }
    }

    if (msg.role === 'user') {
      prompt += `Human: ${msgContent}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${msgContent}\n\n`;
    }
  }

  prompt += 'Assistant: ';
  return prompt;
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

          if (imagePath) {
            images.push({ path: imagePath, index: imageIndex });
            imageIndex++;
          }
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

function saveConversationContext(conversationId, messages) {
  if (!conversationId) return;
  
  conversationContext.set(conversationId, {
    messages: messages,
    lastUpdated: Date.now()
  });
}

function getConversationContext(conversationId) {
  if (!conversationId) return null;
  
  const context = conversationContext.get(conversationId);
  if (!context) return null;
  
  if (Date.now() - context.lastUpdated > CONTEXT_EXPIRE_TIME) {
    conversationContext.delete(conversationId);
    return null;
  }
  
  return context.messages;
}

function cleanupExpiredContext() {
  const now = Date.now();
  for (const [conversationId, context] of conversationContext) {
    if (now - context.lastUpdated > CONTEXT_EXPIRE_TIME) {
      conversationContext.delete(conversationId);
    }
  }
}

setInterval(cleanupExpiredContext, Math.max(CONTEXT_EXPIRE_TIME / 2, 60000));

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model, stream = false, temperature, max_tokens, tools, conversation_id, sandbox, workdir } = req.body;

    const cliModel = mapModel(model);

    // 沙箱模式与工作目录：请求体 > 请求头 > 环境变量默认值
    const requestSandbox = sandbox || req.headers['x-codex-sandbox'] || CODEX_SANDBOX;
    const requestWorkdir = workdir || req.headers['x-codex-workdir'] || CODEX_WORKDIR;

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
    
    let fullMessages = messages;
    if (conversation_id) {
      const previousContext = getConversationContext(conversation_id);
      if (previousContext) {
        fullMessages = [...previousContext, ...messages];
      }
      saveConversationContext(conversation_id, fullMessages);
    }
    
    const { images, tempDir } = extractAndSaveImages(fullMessages);
    
    if (USE_CLI) {
      const systemPrompt = fullMessages.filter(m => m.role === 'system').map(m => contentToString(m.content)).join('\n\n');
      const conversationMessages = fullMessages.filter(m => m.role === 'user' || m.role === 'assistant');
      let prompt = buildPrompt(conversationMessages, images);
      
      const args = ['exec', '--ephemeral', '--ignore-rules', '--json', '--skip-git-repo-check', '--model', cliModel, '--sandbox', requestSandbox];

      if (requestWorkdir) {
        args.push('--cd', requestWorkdir);
      }

      if (images.length > 0) {
        for (const img of images) {
          args.push('--image', img.path);
        }
      }
      
      if (systemPrompt) {
        args.push('-c', `system_prompt='${systemPrompt.replace(/'/g, "\\'")}'`);
      }
      
      if (stream) {
        setupSSE(res);
        const heartbeat = startSSEHeartbeat(res);
        
        const child = spawn('codex', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        
        let buffer = '';
        let fullText = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let stderr = '';
        let isClosed = false;
        let spawnError = null;
        let timedOut = false;
        const chatId = 'chatcmpl-' + Date.now();
        const createdTime = Math.floor(Date.now() / 1000);
        
        const timeout = setTimeout(() => {
          if (!isClosed) {
            timedOut = true;
            console.error('CLI process timed out');
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!isClosed) child.kill('SIGKILL');
            }, 5000);
          }
        }, PROCESS_TIMEOUT);
        
        function sendChunk(content) {
          if (!content) return;
          const chunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model: cliModel,
            choices: [
              {
                index: 0,
                delta: { content: content },
                finish_reason: null,
              },
            ],
          };
          writeSSE(res, JSON.stringify(chunk));
        }
        
        function extractDeltaText(parsed) {
          if (!parsed) return null;
          if (parsed.delta && typeof parsed.delta.text === 'string') return parsed.delta.text;
          if (parsed.item && parsed.item.delta && typeof parsed.item.delta.text === 'string') return parsed.item.delta.text;
          if (parsed.item && typeof parsed.item.text_delta === 'string') return parsed.item.text_delta;
          if (typeof parsed.text_delta === 'string') return parsed.text_delta;
          if (parsed.content && typeof parsed.content.delta === 'string') return parsed.content.delta;
          return null;
        }
        
        function parseBuffer() {
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            try {
              const parsed = JSON.parse(trimmed);
              const type = parsed.type || '';
              
              const deltaText = extractDeltaText(parsed);
              if (deltaText) {
                fullText += deltaText;
                sendChunk(deltaText);
              }
              
              if (type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
                const text = parsed.item.text || '';
                if (text.length > fullText.length) {
                  const remaining = text.slice(fullText.length);
                  if (remaining) {
                    fullText = text;
                    sendChunk(remaining);
                  }
                }
                fullText = text;
              }
              
              if (parsed.type === 'turn.completed' && parsed.usage) {
                promptTokens = parsed.usage.input_tokens || 0;
                completionTokens = parsed.usage.output_tokens || 0;
              }
            } catch (e) {
            }
          }
        }
        
        child.stdout.on('data', (data) => {
          buffer += data.toString();
          parseBuffer();
        });
        
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('error', (error) => {
          spawnError = error;
          stderr += error.message;
        });
        
        let resClosed = false;
        res.on('close', () => {
          resClosed = true;
          if (!isClosed) {
            child.kill('SIGTERM');
          }
        });
        
        child.on('close', (code, signal) => {
          isClosed = true;
          clearTimeout(timeout);
          clearInterval(heartbeat);
          cleanupTempDir(tempDir);
          
          if (buffer.trim()) {
            buffer += '\n';
            parseBuffer();
          }
          
          if (res.writableEnded) return;
          
          const exitedNormally = code === 0 && !signal;
          const wasKilledByClient = resClosed && (signal === 'SIGTERM' || signal === 'SIGKILL');
          
          if (spawnError || timedOut || (!exitedNormally && !wasKilledByClient)) {
            console.error('CLI stream error - code:', code, 'signal:', signal, 'stderr:', stderr.slice(-1000));
            const errorChunk = {
              error: {
                message: timedOut
                  ? `CLI process timed out after ${PROCESS_TIMEOUT}ms`
                  : stderr || `CLI process exited with code ${code}, signal ${signal}`,
                type: 'api_error',
              },
            };
            writeSSE(res, JSON.stringify(errorChunk));
            res.end();
          } else {
            const finalChunk = {
              id: chatId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model: cliModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
            writeSSE(res, JSON.stringify(finalChunk));
            writeSSE(res, '[DONE]');
            res.end();
          }
        });
        
        child.stdin.write(prompt);
        child.stdin.end();
        
      } else {
        const child = spawn('codex', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        
        let buffer = '';
        let fullText = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let stderr = '';
        let isClosed = false;
        let responded = false;
        let spawnError = null;
        let timedOut = false;
        
        const timeout = setTimeout(() => {
          if (!isClosed) {
            timedOut = true;
            console.error('CLI process timed out');
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!isClosed) child.kill('SIGKILL');
            }, 5000);
          }
        }, PROCESS_TIMEOUT);
        
        function parseBuffer() {
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            try {
              const parsed = JSON.parse(trimmed);
              
              if (parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
                fullText = parsed.item.text || '';
              }
              
              if (parsed.type === 'turn.completed' && parsed.usage) {
                promptTokens = parsed.usage.input_tokens || 0;
                completionTokens = parsed.usage.output_tokens || 0;
              }
            } catch (e) {
            }
          }
        }
        
        child.stdout.on('data', (data) => {
          buffer += data.toString();
          parseBuffer();
        });
        
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('error', (error) => {
          spawnError = error;
          stderr += error.message;
        });
        
        let resClosed = false;
        res.on('close', () => {
          resClosed = true;
          if (!isClosed) {
            child.kill('SIGTERM');
          }
        });
        
        child.stdin.write(prompt);
        child.stdin.end();
        
        child.on('close', (code, signal) => {
          isClosed = true;
          clearTimeout(timeout);
          cleanupTempDir(tempDir);
          
          if (responded) return;
          responded = true;
          
          if (buffer.trim()) {
            buffer += '\n';
            parseBuffer();
          }
          
          const exitedNormally = code === 0 && !signal;
          const wasKilledByUs = resClosed && (signal === 'SIGTERM' || signal === 'SIGKILL');
          
          if (spawnError || timedOut || (!exitedNormally && !wasKilledByUs && fullText === '')) {
            console.error('CLI error - code:', code, 'signal:', signal, 'stderr:', stderr.slice(-1000));
            return res.status(500).json({
              error: {
                message: timedOut
                  ? `CLI process timed out after ${PROCESS_TIMEOUT}ms`
                  : stderr || `CLI exited with code ${code}, signal ${signal}`,
                type: 'api_error',
              },
            });
          }
          
          const openAIResponse = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: cliModel,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: fullText,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };
          
          res.json(openAIResponse);
        });
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
            model: cliModel,
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
          model: cliModel,
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
          model: cliModel,
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
      model: cliModel,
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
    
    const proxyReq = http.request(options, (proxyRes) => {
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
    default_model: DEFAULT_MODEL,
    available_models: AVAILABLE_MODELS.map(model => model.id),
    sandbox: CODEX_SANDBOX,
    workdir: CODEX_WORKDIR || process.cwd(),
  });
});

app.listen(PORT, () => {
  console.log(`Codex proxy server running on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
