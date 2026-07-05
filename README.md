# Codex Proxy

一个兼容 OpenAI Chat Completions 接口的轻量代理服务。它可以将 HTTP 请求转发给本机 Codex CLI，也保留了直连 OpenAI API 和 Web 模式的入口。

## 功能

- 提供 OpenAI 风格的 `/v1/chat/completions` 接口
- 支持普通响应和 SSE 流式响应
- 支持文本与 base64 图片输入
- 支持通过 `conversation_id` 续接同一个 codex 会话（基于 `codex exec resume`，只发送增量消息）
- 限制同时运行的 codex 子进程数量，超出排队等待
- 支持为 Codex CLI 指定模型、工作目录和沙箱模式
- 提供模型列表和健康检查接口
- 支持请求超时、SSE 心跳及客户端断开处理

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
| `DEFAULT_MODEL` | `codex-latest` | 健康检查中展示的默认模型 |
| `OPENAI_API_KEY` | 空 | 直连 OpenAI API 时使用的密钥 |
| `USE_CLI` | `false` | 是否通过本机 Codex CLI 响应请求 |
| `USE_WEB_INTERFACE` | `false` | 是否使用 Web 占位模式 |
| `CONTEXT_EXPIRE_TIME` | `3600000` | `conversation_id` 对应会话的过期时间，单位为毫秒 |
| `PROCESS_TIMEOUT` | `600000` | Codex CLI 子进程超时，单位为毫秒（agent 任务耗时较长，默认 10 分钟） |
| `SSE_HEARTBEAT_INTERVAL` | `15000` | SSE 心跳间隔，单位为毫秒 |
| `CODEX_SANDBOX` | `danger-full-access` | Codex 默认沙箱模式 |
| `CODEX_WORKDIR` | 空 | Codex CLI 默认工作目录 |
| `MAX_CONCURRENT_REQUESTS` | `3` | 同时运行的 codex 子进程上限，超出的请求排队等待 |

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
    "model": "gpt-5.5",
    "messages": [
      {"role": "user", "content": "介绍一下当前项目"}
    ]
  }'
```

流式请求示例：

```bash
curl -N http://localhost:3002/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "messages": [
      {"role": "user", "content": "写一个简短的项目摘要"}
    ]
  }'
```

请求体支持以下扩展字段：

| 字段 | 说明 |
| --- | --- |
| `conversation_id` | 会话标识；相同标识会用 `codex exec resume` 续接上一次的 codex 会话，只发送新增的消息，不会重复发送已发过的历史 |
| `sandbox` | 覆盖本次 Codex CLI 请求的沙箱模式（仅对新建会话生效，续接会话时沙箱通过 `-c sandbox_mode` 覆盖） |
| `workdir` | 覆盖本次 Codex CLI 请求的工作目录（仅对新建会话生效，续接会话沿用会话创建时的工作目录） |

`conversation_id` 依赖客户端每轮都携带完整的消息数组（大多数 OpenAI 兼容客户端默认如此）。服务端记录已经处理的用户与助手消息数量，下一轮只截取新增部分发送，不会把 Codex 上一轮的回复再次传回；如果某一轮消息数组没有变长，会返回 400 错误。

**不同 `conversation_id` 之间互相隔离**：每个 id 对应独立的 codex `thread_id` 和独立的子进程，已通过并发测试验证不会串内容。但**同一个** `conversation_id` 如果被并发发送两次（例如客户端重复提交、网络重试），在第一轮完成前两边都会各自新建一个 codex 会话，最终只有后完成的一个会被记录下来继续使用——不会产生错误答案，但可能出现"这一路对话意外分叉、只留下一条"的现象。正常单客户端顺序对话不会触发，仅在同一 id 出现并发写入时才需要注意。

也可以通过请求头传入：

- `X-Codex-Sandbox`
- `X-Codex-Workdir`

请求体配置优先于请求头，请求头优先于环境变量。

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

## LaunchAgent 管理（macOS）

项目当前使用以下 LaunchAgent：

```text
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

### 服务反复退出，提示 `EADDRINUSE`

说明端口已被其他进程占用：

```bash
lsof -nP -iTCP:3002 -sTCP:LISTEN
```

结束确认无用的残留进程后，再重启 LaunchAgent。

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
