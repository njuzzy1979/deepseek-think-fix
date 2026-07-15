# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指导。

## 概述

本地反向代理 shim（Node.js，零依赖），修复 Claude Code 在 thinking 模式下通过 API 聚合商（DMX 等）调用 DeepSeek 等第三方模型时的两种 400 错误：

| 错误信息 | 触发条件 | 修复方式 |
| --- | --- | --- |
| `The content[].thinking … must be passed back` | assistant 含 tool_use 但无 thinking 块 | 注入占位 thinking 块 |
| `The reasoning_content … must be passed back` | 请求**结尾**的 assistant 含 tool_use（CC 的 max_tokens 续写请求） | 剥离未完成 tool_use |

详细根因和排查过程见[修复全记录.md](修复全记录.md)。

## 命令

```powershell
# 启动（自动检测上游、备份 settings.json、启动 watchdog）
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1

# 指定端口启动
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1 -Port 8889

# 仅启动 shim，不修改 settings.json
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1 -NoEdit

# 停止（杀 watchdog + node 进程树，还原 ANTHROPIC_BASE_URL）
powershell.exe -ExecutionPolicy Bypass -File stop-shim.ps1

# 检查 shim 是否在运行
Get-NetTCPConnection -LocalPort 8788 -State Listen

# 查看运行状态（upstream / aliasMap / stats）
(Invoke-WebRequest http://127.0.0.1:8788/health).Content

# 实时查看日志
Get-Content E:\Program\deepseek-think-fix\shim.log -Wait -Tail 10

# 运行测试套件（需要 bash + curl + shim 正在运行）
bash .test-ae.sh

# 运行别名映射单元测试（纯 node，无需 shim）
node .test-alias.js

# 详细模式（日志同步输出到 stdout）
$env:SHIM_VERBOSE = "1"

# 记录 assistant 消息块类型摘要
$env:SHIM_DUMP = "1"

# 关闭上游 4xx/5xx 请求体落盘（默认开启，落盘到 error-dumps/）
$env:SHIM_ERROR_DUMP = "0"

# 静态模型改写（解决 CC 内部硬编码模型名问题）
$env:SHIM_MODEL_REWRITE_RULES = "claude-sonnet-4-6:claude-sonnet-4-6-cc"
```

## 架构

```text
CC ──▶ shim :8788 (shim.js) ──▶ 上游 (cc-switch 代理 或 dmxapi.cn 直连)
              │
              ├─ 请求侧处理（POST /v1/messages）：
              │    ├─ 读 settings.json 构建三类别名映射
              │    ├─ 查静态改写规则（SHIM_MODEL_REWRITE_RULES）
              │    ├─ 改写 body.model 从 CC 标签到真实模型名
              │    ├─ 修复一：assistant 缺 thinking 块 → 注入占位块
              │    └─ 修复二：结尾 assistant + 含 tool_use → 剥离未完成 tool_use
              ├─ 响应侧处理：
              │    ├─ 非流式 JSON：thinking signature 清零
              │    └─ SSE 流：逐 event 改写 thinking signature（content_block_start / signature_delta / delta）
              ├─ 每 3 秒轮询 settings.json：
              │    ├─ BASE_URL 自愈 + 别名映射刷新
              │    └─ trailing comma 容忍性解析
              ├─ 上游 4xx/5xx → 落盘完整请求/响应体到 error-dumps/
              ├─ GET /health → 返回运行状态 JSON
              └─ 崩溃 → watchdog 3 秒后重启
```

### 关键文件

| 文件 | 职责 |
| --- | --- |
| `shim.js` | 核心代理（约 730 行，零依赖）。请求拦截、模型改写、thinking 注入、结尾 tool_use 剥离、SSE signature 改写、settings 监听、/health 端点、统计计数、崩溃保护 |
| `start-shim.ps1` | 启动器：检测上游模式、每日备份 settings.json、生成 `.watchdog.cmd`、启动 watchdog、将 `ANTHROPIC_BASE_URL` 指向 shim |
| `stop-shim.ps1` | 永久停止（不自动重启）：删除 PID 文件 → 杀进程树 → 清理孤儿进程 → 还原 `ANTHROPIC_BASE_URL` |
| `.test-ae.sh` | 综合测试套件（bash + curl，A-F 组，49 项）。覆盖模型识别矩阵、边界条件、流式传输、消息形态变体、别名映射、/health 端点 |
| `.test-alias.js` | 别名映射逻辑单元测试（纯 node，14 项）。测试三类字段对、identity 跳过、多后缀剥离 |
| `.watchdog.cmd` | 自动生成的守护脚本。node 崩溃时重启；PID 文件被删除时干净退出 |
| `error-dumps/` | 上游 4xx/5xx 时落盘的完整请求/响应体（本地调试用，已 gitignore） |

### 模型名语义（关键）

CC 的 `settings.json` 中有三类模型字段，搞错会导致静默路由错误：

- `ANTHROPIC_DEFAULT_<SLOT>_MODEL` — CC 发送到 `body.model` 的显示标签
- `ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME` — 上游**实际运行**的模型（真实名）
- `ANTHROPIC_REASONING_MODEL` / `ANTHROPIC_REASONING_MODEL_NAME` — 推理模型档位
- `ANTHROPIC_MODEL` / `ANTHROPIC_MODEL_NAME` — 全局默认模型档位

`shim.js` 的模型名解析优先级（高→低）：

1. `SHIM_MODEL_REWRITE_RULES` 环境变量（静态规则，优先级最高）
2. settings.json 别名映射（每 3 秒全量重建，无状态）
3. 原始 label 值透传（identity）

### Thinking 修复（两代问题并行覆盖）

**修复一：`content[].thinking` 缺失**（第一代，`fixThinkingRoundtrip`）

**请求侧**（每轮 multi-turn 请求时）：

- 检测 assistant 消息含 `tool_use` 但位置 0 无 `thinking`/`redacted_thinking` → 注入占位块
- 占位块：`{"type":"thinking","thinking":"","signature":"deepseek-think-fix"}`
- DMX 仅校验 thinking 块**存在性**，不校验内容或 signature

**响应侧**（上游返回时）：

- 非流式 JSON：解析 `content` 数组，将 thinking 块的非空 signature 清零
- SSE 流式：逐 event 解析，对 `content_block_start`、`signature_delta`、`delta(type=thinking)` 三种事件中的 thinking signature 清零
- 目的：让 CC 保留 thinking 块内容（CC 丢弃非 Anthropic 签名的 thinking 块）

**修复二：`reasoning_content` 缺失**（第二代，`fixTrailingAssistantToolUse`，2026-07-16 新增）

- 触发条件：请求消息数组的**最后一条**是 `assistant` 且含 `tool_use` 块（CC 因 `max_tokens` 截断发出的续写请求）
- 修复：从结尾 assistant 消息中移除所有 `tool_use` 块（保留 thinking/text），让 DMX 当作正常生成请求处理
- 两代修复互不冲突：一次请求可能先注入占位 thinking（修复一），再剥离结尾 tool_use（修复二）
- 代价：被截断的半成品工具调用会丢失，模型需要重新生成——但避免了 400 硬错误卡死任务

### Settings.json 监听器（自愈机制）

cc-switch 会持续重写 `ANTHROPIC_BASE_URL`。监听器每 3 秒：

1. 检测到外部 BASE_URL 变更（非 shim 地址）
2. 在内存中重新绑定上游（HTTP↔HTTPS 热切换，无需重启）
3. 原子写回 `ANTHROPIC_BASE_URL = http://127.0.0.1:8788`（UTF-8 with BOM）
4. 将真实上游保存到 `backups/last-upstream.txt`
5. 从 settings.json 当前状态全量重建别名映射（无状态，不缓存到磁盘）
6. 容忍 trailing comma（cc-switch 可能写出非标准 JSON，清理后重试解析）

### 上游超时机制

- 默认超时：**300 秒（5 分钟）**，从请求发出到收到第一个响应字节
- 一旦上游开始响应（SSE 流首字节到达），超时计时器立即取消——长时间流式传输不会被打断
- 可通过 `SHIM_UPSTREAM_TIMEOUT` 环境变量覆盖

### /health 端点

`GET http://127.0.0.1:8788/health` 返回：

```json
{
  "status": "ok",
  "uptime": 3600,
  "upstream": "https://www.dmxapi.cn",
  "targets": ["deepseek"],
  "candidateTargets": [],
  "aliasMap": {"claude-label": "deepseek-v4-pro-guan-cc"},
  "stats": {
    "total": 259,
    "fixed": 183,
    "noop": 30,
    "untouched": 46,
    "errors": 0,
    "sseRewritten": 12,
    "trailingToolUseFixed": 3
  }
}
```

### 进程生命周期

- **仅手动启动** — 无开机自启，无任务计划程序注册
- **崩溃恢复**：watchdog 循环，重启间隔 3 秒
- **停止即永久**：`stop-shim.ps1` 删除 PID 文件 → watchdog 在下次检查时退出 → 杀整个进程树

### 已知 CC 行为（shim 无法干预）

CC 的 context compaction、后台摘要等内部操作会**硬编码**发送 `claude-sonnet-4-6`（不走任何 slot 配置，不受 settings.json 别名映射影响）。如需改写，使用 `SHIM_MODEL_REWRITE_RULES`：

```powershell
$env:SHIM_MODEL_REWRITE_RULES = "claude-sonnet-4-6:claude-sonnet-4-6-cc"
```

### 关键设计决策（摘自 修复全记录.md）

1. **轮询而非 fs.watch**：Windows 上外部进程通过 tmp+rename 模式写入 settings.json，`fs.watch` 经常漏事件。3 秒轮询可靠且无感知。
2. **无状态别名映射**：每次 watcher 轮询时从 settings.json 全量重建，以其为唯一数据源。不持久化到磁盘，避免过期映射导致路由错误。
3. **双修复并行覆盖**：`fixThinkingRoundtrip` 解决工具调用后下一轮缺 thinking 的 400；`fixTrailingAssistantToolUse` 解决续写请求中结尾含 tool_use 触发的 `reasoning_content` 400。两路逻辑独立，可能同时命中。
4. **超时计时器在首字节到达后取消**：避免 thinking 长推理被 120s 超时截断（已改为 300s，且 SSE 流开始后不受限）。
5. **`url.parse` 而非 WHATWG URL**：有意使用旧版 API 以最小化代码复杂度。Node 25 的 DEP0169 警告无害。
6. **`SHIM_MODEL_REWRITE_RULES` 优先级最高**：解决 CC 内部硬编码模型名绕过 settings.json 别名映射的问题。
7. **错误诊断落盘**：上游 4xx/5xx 时自动保存完整请求/响应体到 `error-dumps/`。第二代问题是纯靠 curl 构造请求复现不出来的——直到靠这个功能拿到真实流量抓包数据，才在几分钟内锁定根因。不能假设修复一次就一劳永逸，需要持续诊断能力跟踪上游校验规则变更。
