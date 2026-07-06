# Codex Proxy

一个兼容 OpenAI Chat Completions 接口的轻量代理服务。它可以将 HTTP 请求转发给本机 Codex CLI，也保留了直连 OpenAI API 和 Web 模式的入口。

## 功能

- 提供 OpenAI 风格的 `/v1/chat/completions` 接口
- **支持真正的 token 级流式响应**（基于 Codex App Server 的 `item/agentMessage/delta` 事件）
- 支持将 Codex 的追问转换成 IDE 原生交互卡片（Trae `AskUserQuestion`、Roo Code `ask_followup_question`）
- 支持用户选择后的连续追问，并正确接收 `tool` / `tool_result` 结果
- 支持文本与 base64 图片输入
- 支持通过 `conversation_id` 续接同一个 codex 会话（基于 App Server 的 `thread/resume`）
- 限制同时运行的 codex 子进程数量，超出排队等待
- 支持为 Codex CLI 指定模型、工作目录和沙箱模式
- 提供模型列表和健康检查接口
- 支持请求超时、SSE 心跳及客户端断开处理
- **模型名称自动添加 `my-` 前缀**，便于在 IDE 中区分本地代理和云端服务

## 运行要求

- Node.js 18 或更高版本
- npm
- 使用 CLI 模式时，需要安装并登录 Codex CLI，确保 `codex` 命令可用

## 安装与启动

```bash
npm install
cp .env.example .env
npm start
```

开发模式：

```bash
npm run dev
```

服务默认监听 `http://localhost:3002`。

`node_modules/` 和 `.env` 已加入 `.gitignore`，不再提交到仓库；克隆后需要自行 `npm install` 并从 `.env.example` 复制生成 `.env`。包管理器统一用 npm（`package-lock.json`），不再维护 `pnpm-lock.yaml`。

## 配置

配置文件为 `.env`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3002` | HTTP 服务端口 |
| `DEFAULT_MODEL` | `gpt-5.5` | 默认模型（返回时会自动添加 `my-` 前缀） |
| `OPENAI_API_KEY` | 空 | 直连 OpenAI API 时使用的密钥 |
| `USE_CLI` | `true` | 是否通过 Codex App Server 响应请求 |
| `USE_WEB_INTERFACE` | `false` | 是否使用 Web 占位模式 |
| `CONTEXT_EXPIRE_TIME` | `3600000` | `conversation_id` 对应会话的过期时间，单位为毫秒 |
| `PROCESS_TIMEOUT` | `600000` | Codex 请求超时，单位为毫秒（agent 任务耗时较长，默认 10 分钟） |
| `SSE_HEARTBEAT_INTERVAL` | `15000` | SSE 心跳间隔，单位为毫秒 |
| `CODEX_SANDBOX` | `danger-full-access` | Codex 默认沙箱模式 |
| `CODEX_WORKDIR` | 空 | Codex 默认工作目录 |
| `MAX_CONCURRENT_REQUESTS` | `3` | 同时运行的 codex 子进程上限，超出的请求排队等待 |
| `CODEX_LEAN_MODE` | `false` | 精简代理实例：禁用插件、Browser Use、node_repl 与 Playwright MCP，降低固定工具上下文；需要浏览器或文档插件时不要开启 |
| `DEFAULT_REASONING_EFFORT` | 空 | 默认推理强度，例如 `low`、`medium`、`high`；留空时沿用 Codex 配置 |

至少需要满足以下条件之一，否则服务会拒绝启动：

- `USE_CLI=true`
- `USE_WEB_INTERFACE=true`
- 配置有效的 `OPENAI_API_KEY`

沙箱模式可选值：

- `read-only`：只读
- `workspace-write`：允许修改工作区
- `danger-full-access`：不限制文件访问

生产或共享环境建议使用 `workspace-write`，并固定 `CODEX_WORKDIR`。

## API

### 健康检查

```http
GET /health
```

示例：

```bash
curl http://localhost:3002/health
```

### 模型列表

```http
GET /v1/models
```

### 对话

```http
POST /v1/chat/completions
Content-Type: application/json
```

普通请求示例：

```bash
curl http://localhost:3002/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-gpt-5.5",
    "messages": [
      {"role": "user", "content": "介绍一下当前项目"}
    ]
  }'
```

流式请求示例（**推荐，支持实时 token 级输出**）：

```bash
curl -N http://localhost:3002/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "my-gpt-5.5",
    "stream": true,
    "messages": [
      {"role": "user", "content": "写一个简短的项目摘要"}
    ]
  }'
```

**注意**：
- 模型名称会自动添加 `my-` 前缀，例如 `gpt-5.5` → `my-gpt-5.5`
- `stream` 参数默认为 `true`，支持真正的 token 级流式输出
- 流式响应基于 Codex App Server 的 `item/agentMessage/delta` 事件，每个 token 实时发送

请求体支持以下扩展字段：

| 字段 | 说明 |
| --- | --- |
| `conversation_id` | 会话标识；相同标识会使用 App Server 的 `thread/resume` 续接上一次的会话 |
| `sandbox` | 覆盖本次请求的沙箱模式 |
| `workdir` | 覆盖本次请求的工作目录 |
| `reasoning_effort` | 覆盖本次请求的推理强度；简单任务使用 `low` 可减少 reasoning token |

也可以通过请求头传入：

- `X-Codex-Sandbox`
- `X-Codex-Workdir`

请求体配置优先于请求头，请求头优先于环境变量。

## Roo Code 接入

Roo Code 使用 OpenAI Compatible 提供商连接本服务：

| Roo Code 配置 | 值 |
| --- | --- |
| API Provider | `OpenAI Compatible` |
| Base URL | `http://127.0.0.1:3002/v1` |
| API Key | 任意非空字符串，例如 `local` |
| Model ID | `my-gpt-5.5`（或 `my-gpt-5.4`） |

在 Roo Code 的 Custom Headers 中增加：

| Header | 值 |
| --- | --- |
| `X-Codex-Client` | `roo-code` |
| `X-Codex-Sandbox` | `workspace-write` |

代理会从 Roo Code 随请求发送的 `environment_details` 中自动识别 VS Code 工作区，因此一般不需要设置 `X-Codex-Workdir`。这也避免了中文路径放入 HTTP Header 后导致请求无法发出。如果客户端没有发送工作区信息，可以额外设置 `X-Codex-Workdir`，但包含中文或其他非 ASCII 字符时必须先进行 URL 编码。

服务会根据 Roo Code 的系统提示、`ask_followup_question` 工具或 `X-Codex-Client: roo-code` 请求头自动识别 Roo 请求。Codex 的内部文本/XML结果会被代理转换成标准 OpenAI `tool_calls`：需要用户选择时调用 `ask_followup_question`，任务结束时调用 `attempt_completion`。Roo 因而可以正常显示问题、建议选项和完成结果；用户回答后，Roo 会把完整对话放进下一轮请求继续处理。如果调用方另外提供 `conversation_id`，代理也会用 Codex 原生会话续接。

当前 Codex CLI 仍在服务端内部执行文件、命令和 MCP 工具，因此 Roo 只负责对话与追问界面，不会接管这些工具的逐项审批。

## Trae 接入

在 Trae 中新增 OpenAI Compatible 模型：

| Trae 配置 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:3002/v1` |
| API Key | 任意非空字符串，例如 `local` |
| Model | `my-gpt-5.5`（或 `my-gpt-5.4`、`my-gpt-5.4-mini`） |

Trae 会在请求中声明 `AskUserQuestion` 工具，代理会自动读取工具名称和 JSON Schema，无需增加自定义 Header。需要用户确认时，代理把 Codex 生成的追问转换成标准 OpenAI `tool_calls`；Trae 随后显示原生"提问"卡片，包括问题、2～4 个选项和"其他"输入。用户选择后，工具结果会进入下一轮，因此可以继续弹出不同的追问卡片。

### 流式响应行为

- **普通对话**：实时流式输出，文字逐步显示（基于 `item/agentMessage/delta` 事件）
- **首次交互工具调用**：为正确解析 `AskUserQuestion`，会等待完整内容后再显示交互卡片
- **交互工具回答后**：恢复流式输出；收尾阶段只补发尚未输出的尾部文本，不会重复发送整段回答

该适配不是把 XML 直接显示给用户。内部 `<ask_followup_question>` 只是一种 Codex 输出约定，代理会在返回客户端前将它转换为 Trae 的 `AskUserQuestion`。如果界面直接显示 XML，请先确认运行的是最新代码并重启 LaunchAgent：

```bash
launchctl kickstart -k gui/$(id -u)/com.tangwenjing.codex-cli
```

## 流式响应实现

本项目基于 **Codex App Server** 实现了真正的 token 级流式响应：

### 工作原理

1. **App Server 连接**：服务启动时初始化一个常驻的 App Server 进程
2. **Delta 事件映射**：将 `item/agentMessage/delta` 事件直接映射为 OpenAI SSE 格式
3. **智能缓冲策略**：
   - 普通对话：每个 delta 立即发送，实现逐字显示
   - 交互工具调用：首次等待完整内容以正确解析 `AskUserQuestion`
   - 交互回答后：恢复实时流式输出

### 技术细节

| App Server 事件 | OpenAI 兼容输出 |
| --- | --- |
| `item/agentMessage/delta` | `choices[0].delta.content` |
| 交互提问事件 | `tool_calls` (Trae `AskUserQuestion` / Roo `ask_followup_question`) |
| `turn/completed` | `finish_reason: "stop"` + `[DONE]` |
| `turn/interrupt` | 客户端断开连接 |

### 优势

- ✅ **真正的流式**：每个 token 实时发送，不是人为拆分
- ✅ **低延迟**：用户立即看到生成开始，体验流畅
- ✅ **交互兼容**：自动处理 `AskUserQuestion` 等交互工具
- ✅ **标准协议**：完全兼容 OpenAI Chat Completions SSE 格式

## 旧版实现说明（已废弃）

~~之前基于 `codex exec --json` 的实现不支持真正的流式，因为该接口只在 `item.completed` 时返回完整正文。人为拆分会导致某些客户端（如 Trae）停留在"思考中"状态。~~

现已迁移到 App Server，获得了原生的 delta 事件支持。

## 图片输入

CLI 模式支持 OpenAI 风格的 base64 图片内容：

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "请描述这张图片"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ]
}
```

图片会写入系统临时目录，请求结束后自动清理。目前不下载远程图片 URL。

## 浏览器自动化

代理子会话使用独立的 Playwright MCP 执行浏览器任务。由于 LaunchAgent 启动的 `codex exec` 无法访问 Codex Desktop 会话中的 `iab` 实例，代理会为子会话禁用内置 Browser 插件和 `node_repl` MCP，避免 Agent 错误尝试连接 `iab`。

Playwright MCP 需要在 Codex CLI 全局配置中启用：

```bash
codex mcp add playwright -- \
  npx -y @playwright/mcp@latest --browser chrome --isolated
```

这里不使用 `--headless`，因此执行浏览器任务时会打开用户可见的 Chrome 窗口。

可以用以下命令确认状态：

```bash
codex mcp list
```

## LaunchAgent 管理（macOS）

项目当前使用以下 LaunchAgent：

```text
~/Library/LaunchAgents/com.tangwenjing.codex-cli.plist
```

仓库内同时保存了可部署的 [com.tangwenjing.codex-cli.plist](./com.tangwenjing.codex-cli.plist)。该配置直接执行 `/usr/local/bin/node server.js`，不要改回 `zsh -> npm start -> node` 多层包装；否则 `launchctl kickstart` 可能只结束外层进程，残留 Node 会继续占用 3002 端口。

安装或更新配置：

```bash
cp ./com.tangwenjing.codex-cli.plist \
  ~/Library/LaunchAgents/com.tangwenjing.codex-cli.plist
```

加载服务：

```bash
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.tangwenjing.codex-cli.plist
```

重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/com.tangwenjing.codex-cli
```

查看状态：

```bash
launchctl print gui/$(id -u)/com.tangwenjing.codex-cli
```

日志位置：

```text
/tmp/codex-cli.log
/tmp/codex-cli.err
```

## 常见问题

### 流式请求长时间没有内容

服务已为 SSE 禁用压缩缓冲，并在每次写入后立即刷新，同时定期发送心跳。如果仍然延迟，请检查客户端或反向代理是否缓冲 `text/event-stream` 响应。

**普通对话**：应立即看到流式输出（基于 `item/agentMessage/delta` 事件）。

**交互工具调用**：首次调用 `AskUserQuestion` 时，代理需要等待完整内容以正确解析，期间只有 SSE 心跳。交互卡片会在解析完成后整体显示。用户回答后，后续对话恢复流式输出，且最新版本不会在收尾时重复补发整段回答。

### Trae 或 Roo 中看到回答重复一遍

这通常是旧版本服务的流式收尾逻辑导致的：前面已经按 delta 流式输出过一遍，结束时又将完整文本补发了一次。最新版本已修复为仅补发尚未输出的尾部文本。

如果界面里仍出现整段重复，请先重启本地服务或 LaunchAgent，再重新发起一轮对话。

### Trae 显示 `<ask_followup_question>` XML

正常情况下 Trae 应显示原生“提问”卡片。出现 XML 通常表示服务尚未重启到最新版本，或客户端没有在本轮声明 `AskUserQuestion` 工具。可按以下顺序检查：

```bash
launchctl kickstart -k gui/$(id -u)/com.tangwenjing.codex-cli
curl http://127.0.0.1:3002/health
tail -50 /tmp/codex-cli.log
```

日志中应出现类似 `[interactive-tool] AskUserQuestion ...` 的记录。连续追问允许多次调用该工具，不会因为前一张卡片已经回答而被代理拦截。

### 服务反复退出，提示 `EADDRINUSE`

说明端口已被其他进程占用：

```bash
lsof -nP -iTCP:3002 -sTCP:LISTEN
```

确认 LaunchAgent 的 `program` 是 `/usr/local/bin/node`：

```bash
launchctl print gui/$(id -u)/com.tangwenjing.codex-cli
```

如果仍然使用旧的 `zsh`/`npm start` 配置，先复制仓库内 plist，然后执行 `bootout` 和 `bootstrap` 重新加载。结束确认无用的残留进程后，再重启 LaunchAgent。

### Trae 一直停留在"思考中"

~~旧版本基于 `codex exec --json` 时可能出现此问题，因为人为拆分 SSE 正文会导致某些客户端不兼容。~~

**当前版本（App Server）不会出现此问题**。如果遇到，请检查：

1. 服务是否已重启到最新代码
2. 日志中是否显示 `POST /v1/chat/completions 200`
3. 是否是交互工具首次调用（等待解析完成后会显示卡片）

简单对话通常数秒完成。读取大型代码库、执行命令或修改文档可能需要更久，期间会持续发送心跳保持连接。

### Codex CLI 请求超时

检查以下项目：

- `codex` 命令是否在 LaunchAgent 的 `PATH` 中
- Codex CLI 是否已经登录
- 模型名称是否可用
- `CODEX_WORKDIR` 是否存在且有权限访问
- `/tmp/codex-cli.err` 中是否有具体错误

必要时可适当增加 `PROCESS_TIMEOUT`。

## 安全提示

当前服务默认允许跨域请求，且没有内置接口鉴权，不建议直接暴露到公网。请求还可以覆盖工作目录和沙箱模式；在多人或网络环境中使用时，应在反向代理层增加鉴权、限制来源，并限制允许访问的工作目录和沙箱级别。

`conversation_id` 与 codex 会话的映射保存在进程内存中，服务重启后会丢失（对应的 codex 会话仍在磁盘上，只是代理不再记得如何续接）。使用 `conversation_id` 的请求不会加 `--ephemeral`，codex 会把会话记录持久化到本地（通常在 `~/.codex`），不适合处理不希望留存的敏感对话；不带 `conversation_id` 的请求仍然是 `--ephemeral`，不落盘。
