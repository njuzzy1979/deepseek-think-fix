# 修复与优化工作清单

> 基于 [SHIM-AUDIT-REPORT.md](SHIM-AUDIT-REPORT.md) 审查报告  
> 每个条目包含：文件、位置、具体改动、预期效果、验证方式

---

## 🔴 缺陷修复（3 项）

### D1. 删除死代码 `isTargetModel()` 函数

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 113 — 120 行 |
| **改动** | 删除 8 行：`isTargetModel()` 函数定义及上方空行 |
| **风险** | 无——`grep` 确认此函数无任何调用点，handler 中 `isDeepseek(real)` 已覆盖所有场景 |
| **验证** | 运行 `bash .test-ae.sh`，31 项全部通过 |

---

### D2. 统一 `settings.json` 写入编码（BOM）

| 项目 | 内容 |
|------|------|
| **文件** | `start-shim.ps1` |
| **位置** | 第 147 — 151 行 |
| **改动** | 将 `start-shim.ps1` 写入 settings.json 的方式改为 UTF-8 with BOM，与 `shim.js` watcher 的 `atomicWriteSettings()` 一致 |

**具体改动**：

```powershell
# 当前（第 148-150 行）：
$json = $cfg | ConvertTo-Json -Depth 10
$tmp = "$settings.tmp"
[System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine)

# 改为：
$json = $cfg | ConvertTo-Json -Depth 100
$tmp = "$settings.tmp"
$utf8Bom = [System.Text.UTF8Encoding]::new($true)
[System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine, $utf8Bom)
```

**同时修改** `stop-shim.ps1` 第 100-102 行为同样方式（改 `Depth` + 加 `$utf8Bom`）。

| **影响** | 消除 shim.js watcher 与 PowerShell 启动器之间 BOM 反复翻转，减少 cc-switch 的不必要重写 |
| **风险** | 极低——cc-switch 也使用 UTF-8 with BOM，三方（shim.js、cc-switch、start/stop ps1）统一该编码 |
| **验证** | 启动 shim 后检查 `Format-Hex ~/.claude/settings.json | Select-Object -First 3` 首字节为 `EF BB BF` |

---

### D3. `unhandledRejection` 补全堆栈记录

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 197 — 201 行 |
| **改动** | 4 行改为 5 行——当 `reason` 是 Error 对象时，同时记录 `message` 和 `stack` |

```javascript
// 当前：
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`FATAL unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 200);
});

// 改为：
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error
    ? `${reason.message}\n${reason.stack || '(no stack)'}`
    : String(reason);
  log(`FATAL unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 200);
});
```

| **影响** | rejection 崩溃时日志包含完整堆栈，定位问题快得多 |
| **风险** | 无 |
| **验证** | 临时在 shim.js 中加 `Promise.reject(new Error("test stack"))`，查看日志是否含堆栈 |

---

## 🟡 问题修复（4 项）

### P1. 请求体大小限制

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 在 `const PLACEHOLDER_THINKING` 附近（约 155 行）添加常量，修改第 316 行的 `req.on('data')` 处理器 |
| **改动** | 新增约 12 行 |

```javascript
// 新增常量（在 LOG_FILE 附近）：
const MAX_BODY_SIZE = parseInt(process.env.SHIM_MAX_BODY_SIZE || String(5 * 1024 * 1024), 10);
// 5MB 默认上限，对环境变量开放自定义

// 修改 HTTP handler 中的数据累积逻辑（第 316 行）：
let bufSize = 0;
req.on('data', c => {
  bufSize += c.length;
  if (bufSize > MAX_BODY_SIZE) {
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'payload_too_large', message: `request body exceeds ${MAX_BODY_SIZE} bytes` } }));
    }
    req.destroy();
    return;
  }
  chunks.push(c);
});
```

| **影响** | 防止超大请求体导致 OOM crash loop |
| **风险** | CC 正常请求体远小于 5MB。5MB 默认上限提供 10 倍余量 |
| **验证** | `dd if=/dev/zero bs=1M count=6 | curl -X POST http://127.0.0.1:8788/v1/messages --data-binary @-` 应返回 HTTP 413 |

---

### P2. 上游连接超时

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 在 `upReq.on('error')` 之前、`upReq.end(bodyBuf)` 之前（约第 387 行处）添加 |
| **改动** | 新增约 8 行 |

```javascript
// 在 `upReq.on('error', ...)` 之前添加：
const UP_TIMEOUT = parseInt(process.env.SHIM_UPSTREAM_TIMEOUT || '120000', 10);
upReq.setTimeout(UP_TIMEOUT, () => {
  upReq.destroy();
  if (!res.headersSent) {
    res.writeHead(504, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_timeout', message: `upstream did not respond within ${UP_TIMEOUT}ms` } }));
  }
  log(`UPSTREAM TIMEOUT after ${UP_TIMEOUT}ms -> ${CURRENT_UPSTREAM}`);
});
```

| **影响** | 上游 hang 住时 2 分钟后释放连接。可通过 `$env:SHIM_UPSTREAM_TIMEOUT` 覆盖 |
| **风险** | 2 分钟对 thinking 模式的长时间推理可能偏短。环境变量开放自定义 |
| **验证** | 启动 shim 后 kill 上游进程，发一个请求，等待超时 → 日志出现 `UPSTREAM TIMEOUT`，客户端收到 HTTP 504 |

---

### P3. 统一别名映射判断逻辑

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 113 — 120 行 |
| **改动** | 与 D1 合并——删除 `isTargetModel()` 函数，保持 handler 中 `resolveRealModel()` + `isDeepseek(real)` 两步式逻辑作为唯一路径 |
| **风险** | 无——handler 中的两步式逻辑已验证覆盖所有场景（31/31 测试通过） |
| **验证** | 与 D1 一同验证 |

**注意**：此项与 D1 是同一个改动，不重复计工作量。

---

### P4. `.test-ae.sh` 硬编码路径修复

| 项目 | 内容 |
|------|------|
| **文件** | `.test-ae.sh` |
| **位置** | 第 4 行 |
| **改动** | 1 行 |

```bash
# 当前：
SHIMLOG=/e/Program/deepseek-think-fix/shim.log

# 改为：
SHIMLOG="${SHIM_LOG:-$(dirname "$0")/shim.log}"
```

| **影响** | 测试套件可移植到任意目录 |
| **风险** | 无——`$(dirname "$0")` 在 bash 中始终返回脚本所在目录 |
| **验证** | 运行 `bash .test-ae.sh`，31/31 通过 |

---

## 🟢 优化改进（5 项）

### O1. 日志写入改为异步

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 163 行 |
| **改动** | `log()` 函数中 `fs.appendFileSync` → `fs.appendFile` |

```javascript
// 当前：
function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, msg); } catch (_) {}
  if (VERBOSE) process.stdout.write(msg);
}

// 改为：
function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFile(LOG_FILE, msg, () => {}); // fire-and-forget，不阻塞事件循环
  if (VERBOSE) process.stdout.write(msg);
}
```

| **影响** | 高并发下不阻塞事件循环；watchdog crash guard 的 `log()` 调用在 `process.exit(1)` 之前有 200ms 延迟，已有足够时间写入（`writeFileSync` 严格同步反而不如异步 + 延迟的时序安全） |
| **风险** | 极低——唯一的担心是 crash guard 中 `log()` 后立即 `process.exit()`，此时异步写入可能未完成。但 crash guard 已留有 200ms 延迟（`setTimeout(() => process.exit(1), 200)`），异步写入在此窗口内足够完成 |
| **验证** | 运行 `bash .test-ae.sh`，所有日志正常输出；模拟 crash（kill -9 node），检查日志中 crash 前的最后一条记录是否完整 |

---

### O2. `stripBracketSuffix` 支持多后缀

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 88 行 |
| **改动** | 正则替换（1 行） |

```javascript
// 当前：
return s.replace(/\[.*?\]\s*$/, '').trim();

// 改为（添加注释说明）：
// Strip trailing bracket suffixes like [1M] or [128K]. Handles multiple
// suffixes (e.g. "deepseek-v4[1M][legacy]" → "deepseek-v4").
return s.replace(/(?:\[.*?\])+\s*$/, '').trim();
```

| **影响** | 对 `deepseek-v4-pro-guan-cc[1M]` 这类 CC 自动添加的后缀正确处理，即使出现多层后缀 |
| **风险** | 极低——`(?:\[.*?\])+` 比原版 `\[.*?\]` 仅将单次匹配改为贪心重复，现有测试全部覆盖单后缀场景 |
| **验证** | 测试 `stripBracketSuffix("deepseek[1M][legacy]")` → `"deepseek"` |

---

### O3. watcher slow tick 告警

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 246 — 302 行 (`watcherTick` 函数) |
| **改动** | 在 `finally` 块中加一个耗时检查（约 6 行） |

```javascript
function watcherTick() {
  if (watcherBusy) return;
  watcherBusy = true;
  const _tickStart = Date.now();  // 新增
  try {
    // ... 所有现有代码不变 ...
  } catch (e) {
    log(`WATCHER: tick error: ${e.message}`);
  } finally {
    watcherBusy = false;
    const _elapsed = Date.now() - _tickStart;  // 新增
    if (_elapsed > WATCH_INTERVAL_MS * 0.8) {  // 新增
      log(`WATCHER: slow tick ${_elapsed}ms (threshold ${WATCH_INTERVAL_MS}ms)`);  // 新增
    }
  }
}
```

| **影响** | 监控用——当文件系统 I/O 延迟导致 tick 接近或超过间隔时产生告警，方便排查性能问题 |
| **风险** | 无——纯观察代码，不影响任何功能 |
| **验证** | 当前场景下不应触发（正常 tick < 100ms），仅当杀毒软件或其他进程锁住文件系统时才会记录 |

---

### O4. 错误响应格式对齐 Anthropic API

| 项目 | 内容 |
|------|------|
| **文件** | `shim.js` |
| **位置** | 第 390 — 393 行（以及 P1 新增的 413 响应、P2 新增的 504 响应） |
| **改动** | `error` 对象中补 `type` 字段 |

```javascript
// 502 上游错误响应（第 390 — 393 行）：
// 当前：
res.end(JSON.stringify({
  type: 'error',
  error: { message: `shim upstream error: ${err.message}` }
}));

// 改为：
res.end(JSON.stringify({
  type: 'error',
  error: { type: 'proxy_error', message: `shim upstream error: ${err.message}` }
}));
```

| **影响** | 与 Anthropic API / DMX 的错误格式一致，中间件可统一解析 |
| **风险** | 无 |
| **验证** | 关闭上游后发请求，返回的 JSON 中 `error.type === 'proxy_error'` |

---

### O5. `ConvertTo-Json -Depth` 深度提升

| 项目 | 内容 |
|------|------|
| **文件** | `start-shim.ps1`（2 处）、`stop-shim.ps1`（1 处） |
| **位置** | `start-shim.ps1:147`、`stop-shim.ps1:100` |
| **改动** | `-Depth 10` → `-Depth 100` |

```powershell
# 当前（start-shim.ps1:147，stop-shim.ps1:100）：
$json = $cfg | ConvertTo-Json -Depth 10

# 改为：
$json = $cfg | ConvertTo-Json -Depth 100
```

| **影响** | 防止 settings.json 深层嵌套字段被静默截断（`"System.Object[]"`） |
| **风险** | 无——`-Depth 100` 对 settings.json 这种扁平结构零性能影响，纯保险 |
| **验证** | 启动/停止 shim 后 settings.json 内容完整无截断 |

---

## 📊 工作量汇总

| 等级 | 数量 | 文件名 | 预估行改动 |
|------|------|--------|-----------|
| 🔴 缺陷修复 | 3 | `shim.js`（2 处）、`start-shim.ps1`（1 处）、`stop-shim.ps1`（1 处） | ~15 行 |
| 🟡 问题修复 | 3 | `shim.js`（2 处）、`.test-ae.sh`（1 处） | ~25 行 |
| 🟢 优化改进 | 5 | `shim.js`（4 处）、`start-shim.ps1`（1 处）、`stop-shim.ps1`（1 处） | ~20 行 |
| **合计** | **11** | **4 个文件** | **~60 行** |

---

## 📋 执行顺序建议

```
Phase 1 ─ D1(删死代码) → D3(堆栈补全) → O2(多后缀) → O1(异步日志)
          └ shim.js 纯内部改动，不涉及外部行为

Phase 2 ─ P1(请求体限制) → P2(上游超时) → O4(错误格式)
          └ 在 HTTP handler 中添加防御逻辑

Phase 3 ─ D2(统一BOM) → O5(Depth提升)
          └ PowerShell 脚本改动，需要同步改 start + stop

Phase 4 ─ P4(测试路径) → O3(slow tick告警)
          └ 测试套件和监控相关，放在最后
```

---

*请审阅后标记哪些项需要执行、哪些跳过。*
