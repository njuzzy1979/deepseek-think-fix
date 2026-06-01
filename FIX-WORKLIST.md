# 修复与优化工作清单

> 基于 [SHIM-AUDIT-REPORT.md](SHIM-AUDIT-REPORT.md) 审查报告  
> **全部项目已完成（2026-06-01）**

---

## 已完成汇总

| 阶段 | 项目 | 描述 | Git commit |
| --- | --- | --- | --- |
| 短期 | D1+D3+O2+O1 | 删除死代码 / 堆栈补全 / 多后缀 / 日志策略 | `d09d3bd` |
| 短期 | P1+P2+O4 | 请求体限制 / 上游超时 / 错误格式对齐 | `d09d3bd` |
| 短期 | D2+O5 | 统一 BOM 编码 / Depth 提升 | `d09d3bd` |
| 短期 | P4+O3 | 测试路径相对化 / slow tick 告警 | `d09d3bd` |
| 短期 | watcher | trailing comma 容忍性解析 | `c2b1981` |
| 短期 | U2+U3 | REASONING_MODEL 别名 / 日志同步修复 | `c9a7f66` |
| 中期 | U5+U7 | /health 端点 / sseRewritten 统计 | `a85bbfe` |
| 中长期 | N1+N2+N6 | ANTHROPIC_MODEL 别名 / 非流式 signature / .test-alias.js | `a85bbfe` |
| 长期 | N3+N4+N7+超时 | SHIM_MODEL_REWRITE_RULES / transfer-encoding / SSE 统计 / 超时关键修复 | `5c2916a` |

---

## 最终清单（全部 ✅）

### 🔴 缺陷修复

- [x] D1 删除 `isTargetModel()` 死代码
- [x] D2 PowerShell 写入统一 UTF-8 with BOM
- [x] D3 `unhandledRejection` 补全 stack trace

### 🟡 问题修复

- [x] P1 请求体 5MB 上限（HTTP 413）
- [x] P2 上游 300s 超时 + clearTimeout
- [x] P3 统一别名映射判断逻辑（与 D1 合并）
- [x] P4 测试套件路径相对化

### 🟢 优化改进

- [x] O1 日志保持同步写入（异步有竞态）
- [x] O2 `stripBracketSuffix` 多后缀支持
- [x] O3 watcher slow tick 告警
- [x] O4 错误格式补 `error.type`
- [x] O5 `-Depth 10` → `-Depth 100`
- [x] Dead Code DC1 删除 `isTargetModel()`

### ➕ 后续新增

- [x] N1 `ANTHROPIC_MODEL/_NAME` 别名映射
- [x] N2 非流式 JSON 响应 thinking signature 清零
- [x] N3 `SHIM_MODEL_REWRITE_RULES` 静态改写规则
- [x] N4 SSE `transfer-encoding: chunked`
- [x] N5 watcher trailing comma 容忍性
- [x] N6 别名映射逻辑测试分离为 `.test-alias.js`
- [x] N7 /health 端点 + sseRewritten 统计
- [x] 超时修复：clearTimeout 防止 SSE 中断

**总计：22 项全部完成，63 项测试全部通过。**
