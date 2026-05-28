# deepseek-think-fix

修复 Claude Code 通过 DMX（dmxapi.cn）调用 deepseek 模型时，在 thinking 模式下触发的 400 错误：

> `API Error: 400 The content[].thinking in the thinking mode must be passed back to the API.`

---

## 快速开始

### 启动

双击 `start-shim.cmd`（或 `start-shim-hidden.cmd` 静默启动）。

shim 自动检测当前模式（代理 / 直连），备份 settings.json，改写 `ANTHROPIC_BASE_URL` 指向 shim，启动 watchdog。

```
=== Shim started in background ===
  Watchdog PID: 7480
  Node PID:     4488
  Listen:       http://127.0.0.1:8788
  Upstream:     http://127.0.0.1:15721
  Log:          E:\Program\deepseek-think-fix\shim.log

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
# 启动
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

浏览器访问 `http://127.0.0.1:8788`，应返回 404（shim 在转发但路径不对，说明活着）。

**看修复痕迹：**

```powershell
Get-Content E:\Program\deepseek-think-fix\shim.log -Wait -Tail 5
```

- deepseek + 需要修复：`FIXED: injected N thinking block(s) [model=deepseek-v4-pro-guan-cc]`
- deepseek + 别名改写：`FIXED: injected N thinking block(s) [model=deepseek-v4-pro-guan-cc] (rewrote claude-opus-4-7 -> deepseek-v4-pro-guan-cc)`
- 非 deepseek 透传：`untouched [model=claude-opus-4-7]`
- 单轮无工具：`no-op [model=deepseek-v4-pro-guan-cc]`

**CC 实测：**

1. 确保 shim 启动后**重启 Claude Code**
2. 确保 settings.json 中至少一个档位的 `_MODEL_NAME` 包含 `deepseek`
3. EFFORT 选 Extra high
4. 提一个会用工具的问题（如"读一下 README.md"）
5. 应正常返回，不报 400

### 回滚

```powershell
./stop-shim.cmd   # 停 shim + 还原 settings.json
# 重启 Claude Code
```

如果 `backups/last-upstream.txt` 丢失，手动改 settings.json 的 `ANTHROPIC_BASE_URL`，参考 `backups/settings.json.YYYY-MM-DD.bak`。

---

## 它做什么

```text
Claude Code ──▶  shim :8788 (Node.js) ──▶  upstream (cc-switch :15721 或 dmxapi.cn)
                     │
                     ├─ 读 settings.json 推导 _MODEL → _MODEL_NAME 映射
                     ├─ 改写 body.model 从标签到真实模型名
                     ├─ 真实模型是 deepseek-* 且缺 thinking 块 → 注入占位块
                     ├─ 其他模型 → 原样透传
                     ├─ 每 3 秒轮询 settings.json：BASE_URL 被外部改写时自动跟随并写回 :8788
                     ├─ Node 崩溃 → watchdog 3 秒后自动重启
                     └─ 仅 stop-shim.cmd 可停止，停止后不自动重启
```

## 为什么需要它

DeepSeek 经 DMX 后**无条件**返回 thinking 块（无论客户端是否请求）。DMX 的 round-trip 校验要求：如果 assistant 消息中包含 `tool_use`，则必须同时有 `thinking` 块，否则拒绝请求并返回 400。

Claude Code 收到 thinking 块后，由于 `signature` 是 DMX 生成的伪 UUID（不符合 Anthropic 签名预期），CC 在构建下一轮消息时**丢弃了 thinking 块**。到下一轮 multi-turn 请求时，assistant 只剩 `tool_use`，没有 `thinking` → DMX 校验失败 → 400。

shim 在 CC 和上游之间注入一个占位 thinking 块（`signature: "deepseek-think-fix"`），满足 DMX 的存在性校验。上游仅校验 thinking 块的**存在性**，不校验内容或签名。

## 模型名语义

CC 的 settings.json 中有两套模型字段：

| 字段 | 含义 | shim 如何使用 |
|------|------|-------------|
| `ANTHROPIC_DEFAULT_<SLOT>_MODEL` | 显示标签（CC 发到 body.model 的值） | 当作 key，查映射表 |
| `ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME` | **实际调用的模型** | 映射表的目标值 |

shim 从 settings.json 中读取所有档位的 `_MODEL → _MODEL_NAME` 映射，每 3 秒刷新一次。收到 CC 请求时：

1. 查映射表：`body.model` 是 label，真实模型名 = `_MODEL_NAME` 的值
2. 把 `body.model` 改写为真实模型名
3. 真实模型名是 `deepseek-*` → 注入 thinking 占位块
4. 真实模型名不是 deepseek → 原样透传

举例：用户配置 `HAIKU_MODEL = claude-haiku-4-5`，`HAIKU_MODEL_NAME = deepseek-v4-pro-guan-cc`。CC 发 `body.model = claude-haiku-4-5`，shim 改写为 `deepseek-v4-pro-guan-cc`，检测到是 deepseek，注入 thinking 块，上游收到正确的 deepseek 请求。

---

## 进程保护

| 层 | 机制 | 说明 |
|----|------|------|
| L1 — 崩溃自恢复 | watchdog 循环守护 | Node 崩溃 → 3 秒后自动重启 |
| L2 — 异常兜底 | uncaughtException / unhandledRejection | 致命异常先记日志，再 `process.exit(1)` 触发 L1 |
| L3 — 日志轮转 | 启动时检查文件大小 | shim.log 超过 10MB 自动重命名为 `shim.<timestamp>.log` |
| L4 — PID 文件 | .shim-pid.txt | stop-shim 按 PID 精确杀进程树 |

## settings.json watcher（自愈机制）

cc-switch（和某些 provider 切换工具）会持续重写 settings.json 的 `ANTHROPIC_BASE_URL`，覆盖 shim 的改动。shim 内置的 watcher 每 3 秒轮询 settings.json：

1. 发现 `ANTHROPIC_BASE_URL` 被外部改成非 shim 地址 → 将新值作为上游，热切换绑定（HTTP↔HTTPS 协议切换无需重启 shim）
2. 原子写回 `ANTHROPIC_BASE_URL = http://127.0.0.1:8788`
3. 同步更新 `backups/last-upstream.txt`
4. 同时刷新 `_MODEL → _MODEL_NAME` 映射表

---

## 文件结构

| 文件 | 用途 |
|------|------|
| `shim.js` | 核心代理（约 400 行 Node.js，零依赖） |
| `start-shim.ps1` | 智能启动器 |
| `start-shim.cmd` | 双击启动（可见窗口） |
| `start-shim-hidden.cmd` | 双击启动（无窗口，静默） |
| `stop-shim.ps1` | 智能停止器 |
| `stop-shim.cmd` | 双击停止 |
| `.watchdog.cmd` | 自动生成 — watchdog 守护脚本 |
| `.shim-pid.txt` | 自动生成 — watchdog 进程 PID |
| `shim.log` | 运行日志（脱敏，>10MB 自动轮转） |
| `backups/last-upstream.txt` | 原始 BASE_URL（stop-shim 还原用） |
| `backups/settings.json.YYYY-MM-DD.bak` | settings.json 每日备份 |

## 注意事项

### cc-switch 会反复重写 settings.json

cc-switch 在托盘切 provider 或检测到配置变化时会重写 settings.json 的整个 `env` 段。**watcher 已自动处理**：3 秒内检测并改回 `ANTHROPIC_BASE_URL`，不需要手动 stop/start。

### cc-switch 模式切换（代理 ↔ 直连）

shim 自动跟随。切换时 watcher 在 ≤3 秒内完成上游热切换（含 http↔https 协议切换），`_MODEL → _MODEL_NAME` 映射同步刷新。

### cc-switch 会覆写模型字段

`ANTHROPIC_DEFAULT_OPUS_MODEL = claude-opus-4-7` 这类值是 **cc-switch 托盘程序写入的**，不是 shim 改的。shim 只改 `ANTHROPIC_BASE_URL`。要修改模型配置，请在 cc-switch 托盘图标中操作，不要直接编辑 settings.json。

### 端口冲突

默认 8788。改端口：`start-shim.ps1 -Port 8889` / `stop-shim.ps1 -Port 8889`。

### 调试

```powershell
$env:SHIM_VERBOSE = "1"   # 日志同步到 stdout
$env:SHIM_DUMP = "1"       # 记录 assistant 消息块类型摘要
powershell.exe -ExecutionPolicy Bypass -File start-shim.ps1
```

### 安全

- 仅绑定 `127.0.0.1`，外部不可达
- 日志不写消息正文，不写 Authorization / x-api-key
- cc-switch 代理模式下 shim 看不到真实 API key（key 在下游注入）
