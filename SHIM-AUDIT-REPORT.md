# deepseek-think-fix 代码审查报告

> 审查日期：2026-06-01  
> 审查范围：`shim.js`、`start-shim.ps1`、`stop-shim.ps1`、`.test-ae.sh`、`.watchdog.cmd`

---

## 发现摘要

| 等级 | 数量 | 说明 |
|------|------|------|
| 🔴 缺陷 | 3 | 可能导致功能异常或错误的逻辑问题 |
| 🟡 问题 | 4 | 不会立即出错但有隐患 |
| 🟢 优化 | 5 | 代码质量或性能改进 |
| 💀 死代码 | 1 | 定义但从未调用的函数 |

---

## 🔴 缺陷

### D1. `isTargetModel()` 未被调用——别名映射下的非 deepseek 模型可能被错误注入（`shim.js:113-120`）

**问题**：`isTargetModel()` 函数同时检查 `body.model` 标签和别名映射后的真实模型名，但实际请求处理代码（第 331 行）直接调用 `isDeepseek(real)`，只检查 `resolveRealModel()` 之后的真实模型名。

**影响**：当前配置下没有问题。但如果 cc-switch 将 `_MODEL` 设为非 deepseek 标签（如 `claude-opus-4-7`）而 `_MODEL_NAME` 设为 deepseek 模型，则：`resolveRealModel("claude-opus-4-7")` 返回 `deepseek-v4-pro-guan-cc`，`isDeepseek(real)` 正确命中，模型被改写 → 此路径 OK。**但是**——如果在别名映射未及时刷新的窗口期内（watcher 两次 tick 之间），`aliasMap` 可能仍是旧的，导致真实模型名未被解析出来。这个问题较小，但 `isTargetModel` 的存在本身就是混淆——要么删掉它，要么用它替代 `isDeepseek(real)`。

**建议**：要么删除 `isTargetModel()`，要么修改第 331 行为 `isTargetModel(label)` 以利用其双重检查逻辑。推荐删除（当前逻辑已正确）。

---

### D2. `start-shim.ps1` 写入 settings.json 时不带 BOM，与 `shim.js` watcher 产生 ping-pong 效应（`start-shim.ps1:149`）

**问题**：`shim.js` 的 `atomicWriteSettings()`（第 238 行）写入 UTF-8 with BOM，而 `start-shim.ps1` 使用 `[System.IO.File]::WriteAllText()` 写入 UTF-8 **不带 BOM**。如果 cc-switch 也写入不带 BOM（或带 BOM），则 settings.json 的 BOM 状态会在以下三方之间反复翻转：

```
start-shim.ps1  → 无 BOM
shim.js watcher → 有 BOM（收到 cc-switch 改写后写回）
cc-switch       → 取决于版本（可能是任意状态）
```

每次 BOM 翻转都触发文件的 mtime 变更，cc-switch 可能误判为"外部修改"导致不必要的重写。虽然 JSON 解析本身兼容有无 BOM，但这种 churn 会增加文件系统的写负载，极端情况下可能形成 write storm。

**建议**：统一写入方式。
- 方案 A：`start-shim.ps1:149` 改用 `[System.Text.UTF8Encoding]::new($true)` 写入 BOM。
- 方案 B：`shim.js:238` 去掉 BOM，所有写入方统一无 BOM。

推荐**方案 A**，因为 cc-switch 可能期望 BOM。

---

### D3. `unhandledRejection` 处理器只记录 message，丢失 stack trace（`shim.js:197-201`）

**问题**：`uncaughtException` 记录了完整堆栈，但 `unhandledRejection` 只记录 `reason.message` 或 `String(reason)`，缺少堆栈信息。对于 `TypeError`、`ReferenceError` 等未包装在 Promise 中的 rejection，没有堆栈定位信息会极大增加排查难度。

```javascript
// 当前：
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`FATAL unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 200);
});
```

**建议**：
```javascript
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error
    ? `${reason.message}\n${reason.stack || '(no stack)'}`
    : String(reason);
  log(`FATAL unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 200);
});
```

---

## 🟡 问题

### P1. 请求体无大小限制——恶意或异常请求可导致 OOM（`shim.js:320`）

**问题**：`Buffer.concat(chunks)` 无上限地积累所有请求数据块。如果上游异常发送超大请求体，或恶意客户端攻击，shim 的内存会持续增长直至 OOM，被 watchdog 重启，形成 crash loop。

**建议**：添加 configurable 的请求体大小限制：
```javascript
const MAX_BODY_BYTES = parseInt(process.env.SHIM_MAX_BODY_BYTES || (5 * 1024 * 1024), 10);
// 在 'data' 事件处理器中累积检查：
let totalSize = 0;
req.on('data', c => {
  totalSize += c.length;
  if (totalSize > MAX_BODY_BYTES) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'request body too large' } }));
    req.destroy();
    return;
  }
  chunks.push(c);
});
```

---

### P2. 上游连接无超时——hang 住的连接泄露资源（`shim.js:387`）

**问题**：TCP 连接设置了 `server.requestTimeout = 0`（无限），但上游请求没有 `timeout` 设置。如果上游 hang 住（TCP 握手成功但不响应 HTTP），连接将永久占用内存和文件描述符。

**建议**：给上游请求添加合理超时：
```javascript
upReq.setTimeout(120000, () => {
  upReq.destroy();
  if (!res.headersSent) {
    res.writeHead(504, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'upstream timeout' } }));
  }
});
```

---

### P3. `aliasMap` 别名映射在两个地方维护了重复的判断逻辑（`shim.js:331,339`）

**问题**：HTTP handler 中先用 `resolveRealModel(label)` 解析真实模型名，再用 `isDeepseek(real)` 判断是否需要注入。而 `isTargetModel(label)` 原地封装了这两步，但它不被调用。这导致两种推理路径在代码中并存，增加维护困惑。

**建议**：删除 `isTargetModel()`，保持当前 handler 中的两步式判断（清晰且直观）。或在 handler 中统一使用 `isTargetModel` 作为唯一入口。

---

### P4. `.test-ae.sh` 硬编码路径——不可移植（`.test-ae.sh:4`）

**问题**：`SHIMLOG=/e/Program/deepseek-think-fix/shim.log` 硬编码了用户本机的绝对路径。如果仓库移动到其他目录或其他开发者使用，测试套件将静默失败（`last_note` 读取不到日志）。

**建议**：改为相对路径或环境变量：
```bash
SHIMLOG="${SHIM_LOG:-$(dirname "$0")/shim.log}"
```

---

## 🟢 优化

### O1. 同步日志写入可能阻塞事件循环（`shim.js:163`）

**问题**：`fs.appendFileSync` 在高并发场景下会阻塞事件循环。虽然当前场景（个人使用、CC 单连接）下影响极小，但如果多个 CC 实例或自动化工具同时使用，会出现延迟。

**建议**：考虑使用 `fs.appendFile`（异步版本），或使用简单的环形内存 buffer 配合异步刷盘。

---

### O2. `stripBracketSuffix` 对多括号后缀处理不完整（`shim.js:86-89`）

**问题**：`s.replace(/\[.*?\]\s*$/, '')` 仅移除**最后一个**方括号后缀。如果模型名包含嵌套方括号（如 `deepseek-v4[1M][legacy]`），只会移除 `[legacy]`，留下 `deepseek-v4[1M]`——这仍然带有后缀。

**建议**：如果确实需要处理多后缀场景：
```javascript
function stripBracketSuffix(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/(?:\[.*?\])+\s*$/, '').trim();
}
```
否则当前单后缀逻辑足够，可在注释中标注此限制。

---

### O3. `watcherBusy` 互斥锁在极端频率下可能跳过 tick（`shim.js:244,247`）

**问题**：如果前一个 tick 耗时超过 `WATCH_INTERVAL_MS`（3 秒），`watcherBusy` 会导致后续 tick 被跳过。`setInterval` 不会因 skip 而补执行——如果第一个 tick 耗时 5 秒，会丢失第二个 tick。之后恢复正常。

**建议**：当前 tick 处理都是同步 I/O（`readFileSync`、`writeFileSync`），在正常的 settings.json 大小下不会超过 3 秒。但 `atomicWriteSettings` 涉及跨目录 rename（从 `.tmp` 到 settings.json），如果文件系统延迟（如杀毒软件扫描），可能有极低概率超时。可添加 tick 耗时日志用于监控：

```javascript
function watcherTick() {
  if (watcherBusy) return;
  watcherBusy = true;
  const start = Date.now();
  try { /* ... */ }
  finally {
    watcherBusy = false;
    const elapsed = Date.now() - start;
    if (elapsed > WATCH_INTERVAL_MS * 0.8) {
      log(`WATCHER: slow tick ${elapsed}ms`);
    }
  }
}
```

---

### O4. 上游错误响应格式与 Anthropic API 不一致（`shim.js:390-393`）

**问题**：shim 返回的 502 错误体为 `{"type":"error","error":{...}}`，而 Anthropic API 的错误格式为 `{"type":"error","error":{"type":"...","message":"..."}}`。虽然 CC 通常不解析中间代理的错误（它把它当作网络错误），但如果有任何中间件试图解析此格式，可能会混淆。

**建议**：模仿 Anthropic 错误格式：
```javascript
res.end(JSON.stringify({
  type: 'error',
  error: { type: 'proxy_error', message: `shim upstream error: ${err.message}` }
}));
```

---

### O5. `ConvertTo-Json -Depth 10` 可能截断深层嵌套对象（`start-shim.ps1:147, stop-shim.ps1:100`）

**问题**：PowerShell 的 `ConvertTo-Json` 默认深度为 2，`-Depth 10` 提高了限制，但 settings.json 的 `env` 段理论上可以更深（多层嵌套的配置）。如果 depth 不够，深层字段会被静默丢弃（写入字符串如 `"System.Object[]"`）。

**建议**：增加到 `-Depth 20` 或 `-Depth 100`。深度不影响性能（仅影响序列化遍历层数）。

---

## 💀 死代码

### DC1. `isTargetModel()` 函数定义但从未调用（`shim.js:113-120`）

**证据**：`grep -n "isTargetModel" shim.js` 仅在第 113 行定义处匹配，无任何调用点。

**建议**：删除此函数。当前 HTTP handler（第 331 行）使用 `isDeepseek(real)` 已覆盖所有场景，且逻辑更清晰。

---

## 补充测试建议

以下场景目前未被 `.test-ae.sh` 覆盖：

1. **别名映射场景**：当 `_MODEL` 为 Claude 标签、`_MODEL_NAME` 为 deepseek 时，确认模型被正确改写并注入 thinking 块。需要模拟 settings.json 中的别名映射——当前测试直接发送模型名，绕过了别名映射路径。

2. **并发请求**：同时发送多个 deepseek 和 Claude 请求，验证 `aliasMap` 在 watcher 更新期间不出现竞态。

3. **大请求体**：发送超过 10MB 的请求体，验证行为（当前无限制）。

4. **上游断开**：在请求过程中 kill 上游，验证 502 响应和日志记录。

---

*报告完毕。待审阅后确定修复方案。*
