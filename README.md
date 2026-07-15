# deepseek-think-fix

修复 Claude Code 通过 API 聚合商（DMX 等）调用 DeepSeek 等第三方模型时，在 thinking 模式下触发的两种 400 错误：

> **问题一**：`API Error: 400 The content[].thinking in the thinking mode must be passed back to the API.`
> **问题二**：`API Error: 400 The reasoning_content in the thinking mode must be passed back to the API.`

两种错误的字段名不同（`content[].thinking` vs `` `reasoning_content` ``），触发条件不同，需要不同修复策略。shim 同时覆盖两者。详细记录见[修复全记录.md](修复全记录.md)。

---

## 快速开始

### 启动

双击 `start-shim.cmd`（或 `start-shim-hidden.cmd` 静默启动）。

shim 自动检测当前上游（cc-switch 代理或直连），备份 settings.json，将 `ANTHROPIC_BASE_URL` 指向 shim，启动 watchdog。

```text
=== Shim started in background ===
  Watchdog PID: 7480
  Node PID:     4488
  Listen:       http://127.0.0.1:8788
  Upstream:     https://www.dmxapi.cn
  Log:          E:\Program\deepseek-think-fix\shim.log
  Error Dumps:  E:\Program\deepseek-think-fix\error-dumps\

You may close this window. The service runs in the background.
To stop: double-click stop-shim.cmd
```

**启动后可关闭窗口。服务在后台运行。**

### 停止

双击 `stop-shim.cmd`：

- 删除 PID 文件（让 watchdog 自愿退出）
- 杀 watchdog + node 整个进程树
- 清理自动生成文件
- 还原 `ANTHROPIC_BASE_URL`

**停止后不会自动重启**。只有再次手动双击 `start-shim.cmd` 才会重新运行。

### 命令行

```powershell
# 启动（自动检测上游）
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1

# 指定端口
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1 -Port 8889

# 仅启动 shim，不改 settings.json
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1 -NoEdit

# 停止
powershell.exe -ExecutionPolicy Bypass -File stop-shim.ps1
```

### 启动后必须重启 Claude Code

CC 在启动时读取一次 env 之后不再重读。shim 改写 settings.json 后，**必须完全退出 CC（含托盘图标）再重新启动**，CC 才会通过 shim 发送请求。

### 验证

**检查 shim 是否在运行：**

```powershell
Get-NetTCPConnection -LocalPort 8788 -State Listen
```

**查看运行状态（/health 端点）：**

```powershell
(Invoke-WebRequest http://127.0.0.1:8788/health).Content
```

返回 JSON，包含上游地址、别名映射、请求统计：

```json
{
  "status": "ok",
  "uptime": 3600,
  "upstream": "https://www.dmxapi.cn",
  "targets": ["deepseek"],
  "aliasMap": {},
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

**看修复痕迹：**

```powershell
Get-Content E:\Program\deepseek-think-fix\shim.log -Wait -Tail 5
```

| 日志行 | 含义 |
| --- | --- |
| `FIXED: injected N thinking block(s) [model=...]` | 请求侧注入占位块 |
| `FIXED: injected N thinking block(s) [model=...] (rewrote label -> real)` | 别名改写 + 注入 |
| `FIXED: injected N thinking block(s) + dropped trailing unfinished tool_use [model=...]` | 注入占位块 + 剥离结尾未完成 tool_use（问题二修复） |
| `RESPONSE: cleared N thinking signature(s) [stream]` | 响应侧 SSE signature 清零 |
| `RESPONSE: cleared N thinking signature(s) [non-stream]` | 响应侧 JSON signature 清零 |
| `ERROR DUMP: wrote error-dumps/...json` | 上游返回 4xx/5xx，完整请求/响应体已落盘 |
| `untouched [model=...]` | 非 deepseek，透传不修改 |
| `no-op [model=...]` | deepseek 但无需修复，透传 |

**CC 实测：**

1. 确保 shim 启动后**重启 Claude Code**
2. 确保 settings.json 中至少一个档位的 `_MODEL_NAME` 包含 `deepseek`
3. EFFORT 选 Extra high
4. 提一个会用工具的问题（如"读一下 README.md"）
5. 应正常返回，不报 400，且用户能看到完整推理过程

### 回滚

```powershell
./stop-shim.cmd   # 停 shim + 还原 settings.json
# 重启 Claude Code
```

如果 `backups/last-upstream.txt` 丢失，手动改 settings.json 的 `ANTHROPIC_BASE_URL`，参考 `backups/settings.json.YYYY-MM-DD.bak`。

---

## 它做什么

```text
CC ──▶ shim :8788 (Node.js) ──▶ upstream (cc-switch 代理 或 dmxapi.cn 直连)
            │
            ├─ 请求侧（两种并行修复）：
            │    ├─ 读 settings.json 构建模型别名映射（三类字段）
            │    ├─ 查静态改写规则（SHIM_MODEL_REWRITE_RULES）
            │    ├─ 改写 body.model 从标签到真实模型名
            │    ├─ 修复一：assistant 缺 thinking 块 → 注入占位块
            │    └─ 修复二：结尾 assistant + 含 tool_use → 剥离未完成 tool_use
            ├─ 响应侧：
            │    ├─ deepseek 非流式：解析 JSON，thinking signature 清零
            │    └─ deepseek SSE 流：逐 event 改写 thinking signature
            ├─ 每 3 秒轮询 settings.json：
            │    ├─ BASE_URL 被外部改写 → 自动热切换上游并写回
            │    ├─ trailing comma 容忍性解析
            │    └─ 别名映射全量刷新
            ├─ 上游 4xx/5xx → 完整请求/响应体落盘到 error-dumps/（本地调试）
            ├─ Node 崩溃 → watchdog 3 秒后自动重启
            └─ 仅 stop-shim.cmd 可停止
```

## 为什么需要它

### 问题一：`content[].thinking` 400（第一代）

**根因**（两个机制叠加）：

1. **CC 丢弃 thinking 块**：DeepSeek 经 DMX 后返回的 `thinking` 块的 `signature` 是伪 UUID，不符合 Anthropic 签名规范，CC 在构建下一轮消息时丢弃它。
2. **上游 round-trip 校验**：DMX 要求如果 assistant 消息含 `tool_use`，则必须同时有 `thinking` 块，否则返回 400。

两步叠加：CC 丢弃 thinking → 下一轮 assistant 只剩 `tool_use` → DMX 400。

**修复**：
- **请求侧**：在 CC 发出的请求中，对缺少 thinking 块的 assistant 消息注入占位块（signature 任意，DMX 只校验存在性）
- **响应侧**：在上游返回的响应中，将非标准 signature 清零，让 CC 保留 thinking 块内容不丢弃

> 注：第一代校验在当前 DMX 版本下似乎已经放宽（curl 直接发"缺 thinking"的请求也会通过），但注入逻辑保留不删——DMX 随时可能重新收紧校验规则。

### 问题二：`reasoning_content` 400（第二代，2026-07-16 新增）

**错误信息**：`The reasoning_content in the thinking mode must be passed back to the API.`

**触发条件**：请求消息数组的**最后一条**是 `assistant` 消息，且其 `content` 含 `tool_use` 块。对应 CC 因 `max_tokens` 截断、工具调用参数未写完时发出的**续写请求**——CC 把不完整的 assistant 消息（含未完成 tool_use）作为最后一条重新发出，让模型接着补全参数。DMX 要求这类续写请求必须携带 DeepSeek 原生的 `reasoning_content` 字段来延续推理链，但 Anthropic 消息格式无法构造该字段。

**修复**：检测到这种结尾模式时，从最后一条 assistant 消息中**移除所有 `tool_use` 块**（保留 thinking/text），让 DMX 当作正常生成请求处理。代价是那次半成品工具调用会丢失，模型需要重新生成。

**curl 复现参考**：

```bash
# 以 assistant 结尾 + 含 tool_use → 稳定 400
curl -s https://www.dmxapi.cn/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $KEY" \
  -d '{
    "model":"deepseek-v4-pro-cc",
    "max_tokens":256,
    "thinking":{"type":"adaptive"},
    "messages":[
      {"role":"user","content":"用Bash echo hello"},
      {"role":"assistant","content":[
        {"type":"thinking","thinking":"","signature":"deepseek-think-fix"},
        {"type":"text","text":"我来执行"},
        {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hello"}}
      ]}
    ],
    "tools":[{"name":"Bash","description":"run","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]
  }'
```

## 模型名语义与别名映射

CC 的 settings.json 中有多类模型字段，shim 全部覆盖：

| 字段类型 | 示例 | shim 用途 |
| --- | --- | --- |
| `ANTHROPIC_DEFAULT_<SLOT>_MODEL` | `HAIKU_MODEL = claude-label` | 映射 key（CC 发的标签） |
| `ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME` | `HAIKU_MODEL_NAME = deepseek-v4-pro` | 映射目标（真实模型名） |
| `ANTHROPIC_REASONING_MODEL` | `= claude-reasoning-label` | 同上，配合 `_NAME` 字段 |
| `ANTHROPIC_MODEL` | `= my-label` | 同上，配合 `ANTHROPIC_MODEL_NAME` |

**模型名解析优先级**（由高到低）：

1. `SHIM_MODEL_REWRITE_RULES` 静态规则（环境变量）
2. settings.json 别名映射（每 3 秒刷新）
3. 原始 label 值不变（透传）

**例**：`HAIKU_MODEL = claude-label`，`HAIKU_MODEL_NAME = deepseek-v4-pro-guan-cc`。CC 发 `body.model = claude-label`，shim 改写为 `deepseek-v4-pro-guan-cc`，检测到 deepseek，注入 thinking 块。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SHIM_PORT` | `8788` | 监听端口 |
| `SHIM_HOST` | `127.0.0.1` | 监听地址 |
| `SHIM_UPSTREAM` | — | 初始上游（start-shim.ps1 自动传入） |
| `SHIM_TARGET_MODELS` | `deepseek` | 触发注入的模型前缀，逗号分隔 |
| `SHIM_MODEL_REWRITE_RULES` | — | 静态模型改写：`from1:to1,from2:to2` |
| `SHIM_UPSTREAM_TIMEOUT` | `300000` | 上游首字节超时（毫秒），5 分钟 |
| `SHIM_MAX_BODY_SIZE` | `5242880` | 请求体大小上限（字节），5 MB |
| `SHIM_WATCH_SETTINGS` | `1` | 设为 `0` 禁用 settings.json watcher |
| `SHIM_WATCH_INTERVAL_MS` | `3000` | watcher 轮询间隔（毫秒） |
| `SHIM_SETTINGS_PATH` | `~/.claude/settings.json` | settings.json 路径 |
| `SHIM_LOG` | `shim.log` | 日志文件路径 |
| `SHIM_VERBOSE` | `0` | 设为 `1` 将日志同步输出到 stdout |
| `SHIM_DUMP` | `0` | 设为 `1` 记录 assistant 消息块类型摘要 |
| `SHIM_ERROR_DUMP` | `1` | 设为 `0` 关闭上游 4xx/5xx 请求体落盘 |
| `SHIM_ERROR_DUMP_DIR` | `error-dumps/` | 错误诊断文件存放目录 |

### 使用 SHIM_MODEL_REWRITE_RULES

CC 内部的 context compaction / 后台摘要操作会硬编码发送 `claude-sonnet-4-6`（不走任何 slot 配置）。如果你的 DMX 账户没有这个模型的权限，可以用此规则强制改写：

```powershell
$env:SHIM_MODEL_REWRITE_RULES = "claude-sonnet-4-6:claude-sonnet-4-6-cc"
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1
```

---

## 进程保护

| 层 | 机制 | 说明 |
| --- | --- | --- |
| L1 — 崩溃自恢复 | watchdog 循环守护 | Node 崩溃 → 3 秒后自动重启 |
| L2 — 异常兜底 | uncaughtException / unhandledRejection | 致命异常记日志后 exit，触发 L1 |
| L3 — 请求体限制 | 5 MB 上限 | 超大请求返回 413，防 OOM |
| L4 — 日志轮转 | 启动时检查文件大小 | shim.log 超过 10MB 自动轮转 |
| L5 — PID 文件 | .shim-pid.txt | stop-shim 按 PID 精确杀进程树 |

## settings.json watcher（自愈机制）

cc-switch 会持续重写 settings.json。watcher 每 3 秒轮询：

1. 发现 `ANTHROPIC_BASE_URL` 被改成非 shim 地址 → 热切换上游（含 HTTP↔HTTPS）
2. 原子写回 `ANTHROPIC_BASE_URL = http://127.0.0.1:8788`（UTF-8 with BOM）
3. 更新 `backups/last-upstream.txt`（stop-shim 还原用）
4. 全量重建别名映射
5. 容忍 trailing comma（cc-switch 可能写出非标准 JSON）

---

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `shim.js` | 核心代理（约 730 行，零依赖） |
| `start-shim.ps1` | 智能启动器 |
| `start-shim.cmd` | 双击启动（可见窗口） |
| `start-shim-hidden.cmd` | 双击启动（无窗口，静默） |
| `stop-shim.ps1` | 智能停止器 |
| `stop-shim.cmd` | 双击停止 |
| `.test-ae.sh` | 综合测试套件（bash + curl，49 项） |
| `.test-alias.js` | 别名映射逻辑单元测试（node，14 项） |
| `.watchdog.cmd` | 自动生成 — watchdog 守护脚本 |
| `.shim-pid.txt` | 自动生成 — watchdog 进程 PID |
| `shim.log` | 运行日志（脱敏，>10MB 自动轮转） |
| `error-dumps/` | 上游 4xx/5xx 时落盘的完整请求/响应体（本地调试，已 gitignore） |
| `backups/last-upstream.txt` | 原始 BASE_URL（stop-shim 还原用） |
| `backups/settings.json.YYYY-MM-DD.bak` | settings.json 每日备份 |

## 注意事项

### thinking 模式下"长时间思考但无响应"

如果 CC 提示 "thought for xxxs" 秒数一直增加但无输出，多半是上游（DMX）长时间未返回首字节。shim 的超时设置为 **5 分钟**（从请求发出到收到第一个响应字节）。超时后返回 504。

如需调整：`$env:SHIM_UPSTREAM_TIMEOUT = "600000"` 改为 10 分钟。

SSE 流一旦开始传输，就不受此超时限制——超时仅适用于等待首字节阶段。

### CC 内部操作发送 claude-sonnet-4-6

CC 的 context compaction、后台摘要等内部操作会硬编码发送 `claude-sonnet-4-6`，不走任何 slot 配置。shim 无法通过 settings.json 别名映射干预，需要用 `SHIM_MODEL_REWRITE_RULES` 静态规则覆盖（见上文环境变量说明）。

### cc-switch 会反复重写 settings.json

watcher 在 3 秒内检测并改回，不需要手动 stop/start。

### 端口冲突

默认 8788。改端口：`start-shim.ps1 -Port 8889` / `stop-shim.ps1 -Port 8889`。

### 调试

```powershell
$env:SHIM_VERBOSE = "1"   # 日志同步到 stdout
$env:SHIM_DUMP    = "1"   # 记录 assistant 消息块类型摘要
$env:SHIM_ERROR_DUMP = "1"  # 上游 4xx/5xx 时完整请求/响应体落盘（默认开启）
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1
```

遇到新的 400 错误变体时，先看 `error-dumps/` 目录下的落盘文件，拿到真实请求体再做根因定位——手工 curl 构造的孤立请求往往复现不出真实场景的触发条件。详见[修复全记录.md 第10章](修复全记录.md)。

### 安全

- 仅绑定 `127.0.0.1`，外部不可达
- 日志不写消息正文，不写 Authorization / x-api-key
- cc-switch 代理模式下 shim 看不到真实 API key
