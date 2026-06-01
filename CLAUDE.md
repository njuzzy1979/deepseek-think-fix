# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指导。

## 概述

本地反向代理 shim（Node.js，零依赖），修复 Claude Code 在 thinking 模式下通过 DMX（dmxapi.cn）调用 DeepSeek 时的 400 错误。shim 位于 CC 与上游之间，在缺少 `thinking` 块的 assistant 消息中注入占位块，满足 DMX 的往返校验，而不修改实际响应内容。

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

# 实时查看日志
Get-Content E:\Program\deepseek-think-fix\shim.log -Wait -Tail 10

# 运行测试套件（需要 bash + curl + shim 正在运行）
bash .test-ae.sh

# 详细模式（日志同步输出到 stdout）
$env:SHIM_VERBOSE = "1"

# 记录 assistant 消息块类型摘要
$env:SHIM_DUMP = "1"
```

## 架构

```
CC ──▶ shim :8788 (shim.js) ──▶ 上游 (cc-switch 代理 或 dmxapi.cn 直连)
              │
              ├─ 读取 settings.json 构建 _MODEL → _MODEL_NAME 别名映射
              ├─ 将 body.model 从 CC 显示标签改写为真实模型名
              ├─ deepseek-* 模型 + 缺少 thinking 块 → 注入占位块
              ├─ 非 deepseek 模型 → 透明透传
              ├─ 每 3 秒轮询 settings.json：BASE_URL 自愈 + 别名刷新
              └─ 崩溃 → watchdog 3 秒后重启
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `shim.js` | 核心代理（约 410 行，零依赖）。处理请求拦截、模型改写、thinking 注入、settings 监听、日志、崩溃保护 |
| `start-shim.ps1` | 启动器：检测上游模式、每日备份 settings.json、生成 `.watchdog.cmd`、启动 watchdog、将 `ANTHROPIC_BASE_URL` 指向 shim |
| `stop-shim.ps1` | 永久停止（不自动重启）：删除 PID 文件 → 杀进程树 → 清理孤儿进程 → 还原 `ANTHROPIC_BASE_URL` |
| `.test-ae.sh` | 综合测试套件（bash + curl）。覆盖模型识别矩阵、边界条件、流式传输、消息形态变体 |
| `.watchdog.cmd` | 自动生成的守护脚本。node 崩溃时重启；PID 文件被删除时干净退出 |

### 模型名语义（关键）

CC 的 `settings.json` 中有两层模型字段。搞错会导致静默路由错误：

- `ANTHROPIC_DEFAULT_<SLOT>_MODEL` — CC 发送到 `body.model` 的显示标签（如 `claude-opus-4-7`）
- `ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME` — 上游**实际运行**的模型（如 `deepseek-v4-pro-guan-cc`）

`shim.js` 在启动时和每次 watcher 轮询时从所有 `_MODEL → _MODEL_NAME` 对构建别名映射。收到请求时，在映射中查找 `body.model`，改写为真实模型名，且仅在**真实**模型名以 `deepseek` 开头时才注入 thinking 块。

### Thinking 注入逻辑

- 仅对**解析后的真实模型名**匹配 `deepseek` 或 `deepseek-*` 的请求触发
- 仅在 assistant 消息含有 `tool_use` 但位置 0 没有 `thinking`/`redacted_thinking` 块时注入
- 占位块：`{"type":"thinking","thinking":"","signature":"deepseek-think-fix"}`
- DMX 仅校验 thinking 块的**存在性**，不校验内容或签名

### Settings.json 监听器（自愈机制）

cc-switch 会持续重写 settings.json 中的 `ANTHROPIC_BASE_URL`。监听器：

1. 在 3 秒内检测到外部 BASE_URL 变更（非 shim 地址）
2. 在内存中重新绑定上游（HTTP↔HTTPS 热切换，无需重启）
3. 原子写回 `ANTHROPIC_BASE_URL = http://127.0.0.1:8788`
4. 将真实上游保存到 `backups/last-upstream.txt`，供 stop-shim 还原
5. 从 settings.json 当前状态重建别名映射（无状态 — 不缓存到磁盘）

### 进程生命周期

- **仅手动启动** — 无开机自启，无任务计划程序注册
- **崩溃恢复**：watchdog 循环（`:loop ... node shim.js ... goto loop`），重启间隔 3 秒
- **停止即永久**：`stop-shim.ps1` 删除 PID 文件 → watchdog 在下次检查时退出 → 杀整个进程树 → 下次手动 `start-shim` 前不会自动重启

### 关键设计决策（摘自 修复全记录.md）

1. **轮询而非 fs.watch**：Windows 上外部进程通过 tmp+rename 模式写入 settings.json，`fs.watch` 经常漏事件。3 秒轮询可靠且无感知。
2. **无状态别名映射**：每次 watcher 轮询时从 settings.json 全量重建，以其为唯一数据源。绝不持久化到磁盘 —— 过期的缓存映射曾导致路由错误。
3. **占位签名是任意的**：DMX 仅校验 thinking 块的存在性，不校验内容。签名 `deepseek-think-fix` 是故意留下的标记，不是密码学值。
4. **使用 `url.parse` 而非 WHATWG URL**：shim.js 有意使用旧版 API 以最小化代码复杂度。Node 25 的 DEP0169 警告无害。
