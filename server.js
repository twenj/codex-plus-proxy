require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
// 添加上下文存储
const conversationContext = new Map();
// 添加上下文过期时间（默认1小时）
const CONTEXT_EXPIRE_TIME = process.env.CONTEXT_EXPIRE_TIME || 3600000;

const app = express();
const PORT = process.env.PORT || 3002;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'codex-latest';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_WEB_INTERFACE = process.env.USE_WEB_INTERFACE === 'true';
const USE_CLI = process.env.USE_CLI === 'true';

if (!USE_WEB_INTERFACE && !USE_CLI && !OPENAI_API_KEY) {
  console.error('Error: Either OPENAI_API_KEY is required, or USE_WEB_INTERFACE=true, or USE_CLI=true must be set in .env file');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

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
  
  // 清理过期上下文
  cleanupExpiredContext();
}

function getConversationContext(conversationId) {
  if (!conversationId) return null;
  
  const context = conversationContext.get(conversationId);
  if (!context) return null;
  
  // 检查是否过期
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

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model, stream = false, temperature, max_tokens, tools, conversation_id } = req.body;
    
    const cliModel = mapModel(model);
    
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
      
      const args = ['exec', '--ephemeral', '--ignore-rules', '--json', '--skip-git-repo-check', '--model', cliModel];
      
      if (images.length > 0) {
        for (const img of images) {
          args.push('--image', img.path);
        }
      }
      
      if (systemPrompt) {
        args.push('-c', `system_prompt='${systemPrompt.replace(/'/g, "\\'")}'`);
      }
      
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const child = spawn('codex', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        
        let buffer = '';
        let fullText = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let responseStarted = false;
        
        child.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            try {
              const parsed = JSON.parse(trimmed);
              
              if (parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
                const text = parsed.item.text || '';
                fullText = text;
                
                const chunkSize = 10;
                for (let i = 0; i < text.length; i += chunkSize) {
                  const chunkText = text.slice(i, i + chunkSize);
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
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
                responseStarted = true;
              }
              
              if (parsed.type === 'turn.completed' && parsed.usage) {
                promptTokens = parsed.usage.input_tokens || 0;
                completionTokens = parsed.usage.output_tokens || 0;
              }
            } catch (e) {
            }
          }
        });
        
        child.stderr.on('data', (data) => {
        });
        
        child.on('close', (code) => {
          cleanupTempDir(tempDir);
          if (code !== 0 && !res.writableEnded) {
            console.error(`CLI process exited with code ${code}`);
            const errorChunk = {
              error: {
                message: `CLI process exited with code ${code}`,
                type: 'api_error',
              },
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.end();
          } else if (!res.writableEnded) {
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
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
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
        
        child.stdout.on('data', (data) => {
          buffer += data.toString();
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
        });
        
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        child.stdin.write(prompt);
        child.stdin.end();
        
        child.on('close', (code) => {
          cleanupTempDir(tempDir);
          if (code !== 0) {
            console.error('CLI exited with code', code, 'stderr:', stderr);
            return res.status(500).json({
              error: {
                message: stderr || `CLI exited with code ${code}`,
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
      const requestBody = {
        model: cliModel,
        messages: fullMessages,
        stream: stream,
      };
      
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
              content: '这是来自网页版的响应，需要进一步实现具体逻辑。',
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
  });
});

app.listen(PORT, () => {
  console.log(`Codex proxy server running on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});