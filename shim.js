#!/usr/bin/env node
'use strict';

// deepseek-think-fix — adaptive request-side shim.
//
// See README.md for full description.

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const url   = require('url');

const LISTEN_HOST = process.env.SHIM_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.SHIM_PORT || '8788', 10);
const SHIM_URL    = `http://${LISTEN_HOST}:${LISTEN_PORT}`;

// Mutable upstream state. setUpstream() rebinds these at runtime so the
// settings.json watcher can follow cc-switch when it changes host/port,
// without restarting the shim or dropping in-flight requests.
let UP, UP_PORT, UP_IS_TLS, upstreamModule, CURRENT_UPSTREAM;

// Returns true if rawUrl looks like the shim itself (self-loop guard).
function looksLikeShim(rawUrl) {
  try {
    const p = url.parse(rawUrl);
    if (!p.hostname) return false;
    const port = parseInt(p.port || (p.protocol === 'https:' ? '443' : '80'), 10);
    const isLocal = p.hostname === '127.0.0.1' || p.hostname === 'localhost' || p.hostname === LISTEN_HOST;
    return isLocal && port === LISTEN_PORT;
  } catch (_) { return false; }
}

function setUpstream(rawUrl) {
  const parsed = url.parse(rawUrl);
  if (!parsed.protocol || !parsed.hostname) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (looksLikeShim(rawUrl)) return false;
  const isTls = parsed.protocol === 'https:';
  UP = parsed;
  UP_PORT = parseInt(parsed.port || (isTls ? '443' : '80'), 10);
  UP_IS_TLS = isTls;
  upstreamModule = isTls ? https : http;
  CURRENT_UPSTREAM = rawUrl;
  return true;
}

// Initial upstream from env (launcher passes the detected upstream URL).
const UPSTREAM_URL = process.env.SHIM_UPSTREAM || 'http://127.0.0.1:5000';
if (!setUpstream(UPSTREAM_URL)) {
  console.error(`[shim] invalid SHIM_UPSTREAM: ${UPSTREAM_URL}`);
  process.exit(2);
}

// Only deepseek-family models need the thinking round-trip fix.
//
// Model semantics in CC's settings.json env:
//   ANTHROPIC_DEFAULT_<SLOT>_MODEL       = CC-side label (what CC puts in
//                                          body.model when /model <slot>).
//                                          Only a display tag, has NO bearing
//                                          on what the upstream actually runs.
//   ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME  = the REAL model the upstream runs.
//                                          This is the source of truth.
//
// So:
//   - CC sends body.model = _MODEL value (claude-haiku-4-5 etc.)
//   - shim looks up that label in the alias map below to find the real
//     model name (= _MODEL_NAME), rewrites body.model to it, and forwards.
//   - If the real model is deepseek-*, inject the thinking placeholder block.
//
// Why rewrite: in direct mode (no cc-switch in the path) the upstream gets
// whatever shim sends. If the user wants deepseek but CC sends claude-*,
// the upstream would run claude-* unless shim rewrites. In cc-switch
// proxy mode the rewrite is also harmless — cc-switch routes by the model
// string regardless of its origin.
const TARGET_MODELS = (
  process.env.SHIM_TARGET_MODELS ||
  'deepseek'
).split(',').map(s => s.trim()).filter(Boolean);

// Static model rewrite rules — env SHIM_MODEL_REWRITE_RULES.
// Format: "from1:to1,from2:to2"
// Applied BEFORE alias map lookup. Useful for overriding CC's hardcoded
// internal model names (e.g. claude-sonnet-4-6 used by compaction).
// Example: SHIM_MODEL_REWRITE_RULES=claude-sonnet-4-6:claude-sonnet-4-6-cc
const staticRewriteMap = new Map(
  (process.env.SHIM_MODEL_REWRITE_RULES || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.includes(':'))
    .map(s => { const i = s.indexOf(':'); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; })
    .filter(([k, v]) => k && v && k !== v)
);

// label (body.model from CC) → real model name (from _MODEL_NAME).
// Rebuilt from settings.json on every watcher tick and on startup.
let aliasMap = new Map();

function stripBracketSuffix(s) {
  if (typeof s !== 'string') return '';
  // Strip trailing bracket suffixes like [1M] or [128K]. Handles multiple
  // suffixes (e.g. "deepseek-v4[1M][legacy]" → "deepseek-v4").
  return s.replace(/(?:\[.*?\])+\s*$/, '').trim();
}

// Returns true if the model name (real, post-alias) is in the deepseek family.
function isDeepseek(model) {
  if (!model) return false;
  const m = stripBracketSuffix(model);
  for (const t of TARGET_MODELS) {
    if (m === t) return true;
    if (m.startsWith(t + '-')) return true;
  }
  return false;
}

// Look up the real model name.
// Priority: staticRewriteMap (env) > aliasMap (settings.json) > identity.
function resolveRealModel(labelFromBody) {
  if (!labelFromBody) return labelFromBody;
  if (staticRewriteMap.has(labelFromBody)) return staticRewriteMap.get(labelFromBody);
  if (aliasMap.has(labelFromBody)) return aliasMap.get(labelFromBody);
  return labelFromBody;
}

// Build alias map from CC settings.json env. For every slot, map _MODEL value
// (the label CC sends in body.model) → _MODEL_NAME value (the real model).
// Handles both ANTHROPIC_DEFAULT_<SLOT>_MODEL/_MODEL_NAME pairs and the
// ANTHROPIC_REASONING_MODEL/ANTHROPIC_REASONING_MODEL_NAME pair.
function buildAliasMapFromSettings(settings) {
  const next = new Map();
  const env = settings && settings.env;
  if (!env || typeof env !== 'object') return next;

  function addPair(label, real) {
    label = stripBracketSuffix(label);
    real  = stripBracketSuffix(real);
    if (!label || !real) return;
    if (label === real) return; // identity mapping is meaningless
    next.set(label, real);
  }

  for (const key of Object.keys(env)) {
    // ANTHROPIC_DEFAULT_<SLOT>_MODEL → ANTHROPIC_DEFAULT_<SLOT>_MODEL_NAME
    const m = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL$/);
    if (m) {
      addPair(env[key], env[`ANTHROPIC_DEFAULT_${m[1]}_MODEL_NAME`] || '');
      continue;
    }
    // ANTHROPIC_REASONING_MODEL → ANTHROPIC_REASONING_MODEL_NAME
    if (key === 'ANTHROPIC_REASONING_MODEL') {
      addPair(env[key], env['ANTHROPIC_REASONING_MODEL_NAME'] || '');
    }
    // ANTHROPIC_MODEL → ANTHROPIC_MODEL_NAME
    if (key === 'ANTHROPIC_MODEL') {
      addPair(env[key], env['ANTHROPIC_MODEL_NAME'] || '');
    }
  }
  return next;
}

const LOG_FILE  = process.env.SHIM_LOG || path.join(__dirname, 'shim.log');
const START_TIME = Date.now();

// Runtime counters — exposed via /health.
const stats = { total: 0, fixed: 0, noop: 0, untouched: 0, errors: 0, sseRewritten: 0 };

// Candidate third-party models discovered from settings.json. Observability only
// for now — does not change injection behavior automatically.
const candidateTargets = new Set();
const VERBOSE  = process.env.SHIM_VERBOSE === '1';
const DUMP     = process.env.SHIM_DUMP === '1';

// L3 data guard — cap request body at ~5 MB (configurable).
const MAX_BODY_SIZE = parseInt(process.env.SHIM_MAX_BODY_SIZE || String(5 * 1024 * 1024), 10);

// L4: log rotation — cap shim.log at ~10 MB. If over, rename with timestamp.
try {
  const stat = fs.statSync(LOG_FILE);
  if (stat.size > 10 * 1024 * 1024) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = LOG_FILE.replace(/\.log$/, `.${ts}.log`);
    fs.renameSync(LOG_FILE, rotated);
  }
} catch (_) { /* file doesn't exist yet — fine */ }

const PLACEHOLDER_THINKING = {
  type: 'thinking',
  thinking: '',
  signature: 'deepseek-think-fix'
};

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, msg); } catch (_) {}
  if (VERBOSE) process.stdout.write(msg);
}

function summarize(body) {
  if (!body || !Array.isArray(body.messages)) return '(no messages)';
  return body.messages.map((m, i) => {
    const c = Array.isArray(m.content)
      ? '[' + m.content.map(b => (b && b.type) || '?').join(',') + ']'
      : 'str';
    return `${m.role}#${i}${c}`;
  }).join(' ');
}

function fixThinkingRoundtrip(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let injected = 0;
  for (const msg of body.messages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const hasToolUse = msg.content.some(b => b && b.type === 'tool_use');
    if (!hasToolUse) continue;
    const first = msg.content[0];
    if (first && (first.type === 'thinking' || first.type === 'redacted_thinking')) continue;
    msg.content.unshift(Object.assign({}, PLACEHOLDER_THINKING));
    injected++;
  }
  return injected;
}

// Streaming response-side fix: normalize non-Anthropic thinking signatures so
// Claude Code keeps the thinking block instead of dropping it on the next turn.
function rewriteJsonThinkingSignatures(obj) {
  let changed = 0;
  if (!obj || !Array.isArray(obj.content)) return changed;
  for (const block of obj.content) {
    if (!block || block.type !== 'thinking') continue;
    if (typeof block.signature === 'string' && block.signature !== '') {
      block.signature = '';
      changed++;
    }
  }
  return changed;
}

function createSseRewriter(targetIsDeepseek) {
  let buffer = '';
  let totalRewritten = 0;
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      const out = [];
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parts = eventBlock.split('\n').map(line => rewriteSseDataLine(line, targetIsDeepseek));
        totalRewritten += parts.reduce((s, r) => s + r.changed, 0);
        out.push(parts.map(r => r.line).join('\n') + '\n\n');
      }
      return out;
    },
    flush() {
      if (!buffer) return '';
      const parts = buffer.split('\n').map(line => rewriteSseDataLine(line, targetIsDeepseek));
      totalRewritten += parts.reduce((s, r) => s + r.changed, 0);
      buffer = '';
      return parts.map(r => r.line).join('\n');
    },
    getRewritten() { return totalRewritten; }
  };
}

function rewriteSseDataLine(line, targetIsDeepseek) {
  if (!targetIsDeepseek || !line.startsWith('data: ')) return { line, changed: 0 };
  const raw = line.slice(6);
  if (!raw || raw === '[DONE]') return { line, changed: 0 };
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return { line, changed: 0 }; }

  let changed = 0;

  if (obj && obj.type === 'content_block_start' && obj.content_block && obj.content_block.type === 'thinking') {
    if (typeof obj.content_block.signature === 'string' && obj.content_block.signature !== '') {
      obj.content_block.signature = '';
      changed++;
    }
  }

  if (obj && obj.delta && obj.delta.type === 'thinking' && typeof obj.delta.signature === 'string' && obj.delta.signature !== '') {
    obj.delta.signature = '';
    changed++;
  }

  if (!changed) return { line, changed: 0 };
  return { line: 'data: ' + JSON.stringify(obj), changed };
}

// L2: crash guard — catch unhandled errors, log them, then exit so watchdog restarts.
process.on('uncaughtException', err => {
  log(`FATAL uncaughtException: ${err.message}\n${err.stack || '(no stack)'}`);
  setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error
    ? `${reason.message}\n${reason.stack || '(no stack)'}`
    : String(reason);
  log(`FATAL unhandledRejection: ${msg}`);
  setTimeout(() => process.exit(1), 200);
});

// ---------------------------------------------------------------------------
// settings.json self-healing watcher
//
// Only purpose: when cc-switch (or anything else) rewrites
// ANTHROPIC_BASE_URL away from the shim, detect it and:
//   1. Treat the new value as the real upstream → setUpstream() rebinds in
//      memory (no restart).
//   2. Atomically rewrite settings.json back to the shim URL so the next
//      CC startup still routes through us.
//   3. Save the real upstream to backups/last-upstream.txt so stop-shim
//      can restore it cleanly.
//
// Disable with env SHIM_WATCH_SETTINGS=0.
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS  = parseInt(process.env.SHIM_WATCH_INTERVAL_MS || '3000', 10);
const WATCH_ENABLED      = process.env.SHIM_WATCH_SETTINGS !== '0';
const SETTINGS_PATH      = process.env.SHIM_SETTINGS_PATH ||
                           path.join(os.homedir(), '.claude', 'settings.json');
const LAST_UPSTREAM_FILE = path.join(__dirname, 'backups', 'last-upstream.txt');

function persistLastUpstream(rawUrl) {
  try {
    const dir = path.dirname(LAST_UPSTREAM_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LAST_UPSTREAM_FILE, rawUrl, 'utf8');
  } catch (e) {
    log(`WATCHER: failed to persist last-upstream: ${e.message}`);
  }
}

function atomicWriteSettings(settings) {
  const tmp = SETTINGS_PATH + '.shim.tmp';
  // Match CC / cc-switch encoding: UTF-8 with BOM. JSON.parse can't handle
  // a leading BOM so we strip it on read (see watcherTick).
  const data = '﻿' + JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

let watcherTimer = null;
let watcherBusy = false;

function watcherTick() {
  if (watcherBusy) return;
  watcherBusy = true;
  const _tickStart = Date.now();
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    let raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let settings;
    try { settings = JSON.parse(raw); }
    catch (_) {
      // Tolerate trailing commas written by cc-switch (e.g. "value",\n  }).
      // Strip commas immediately before ] or } and retry once.
      const cleaned = raw.replace(/,(\s*[}\]])/g, '$1');
      try { settings = JSON.parse(cleaned); }
      catch (e) { log(`WATCHER: settings.json parse error, skip: ${e.message}`); return; }
    }
    if (!settings || !settings.env) return;

    // (a) Refresh alias map from settings.json (source of truth).
    //     Every tick rebuilds it from scratch — no stale cache, no disk
    //     persistence. If cc-switch swaps a slot's _MODEL_NAME, the next
    //     tick reflects it within WATCH_INTERVAL_MS.
    const newAlias = buildAliasMapFromSettings(settings);

    // Discover third-party model candidates for future generalized fixes.
    candidateTargets.clear();
    for (const real of newAlias.values()) {
      const m = stripBracketSuffix(real);
      if (!m) continue;
      const lower = m.toLowerCase();
      if (lower.startsWith('deepseek')) continue;
      if (lower.startsWith('claude')) continue;
      if (lower.startsWith('gpt-')) continue;
      candidateTargets.add(m);
    }

    const aliasChanged = (newAlias.size !== aliasMap.size) ||
      [...newAlias].some(([k, v]) => aliasMap.get(k) !== v);
    if (aliasChanged) {
      aliasMap = newAlias;
      const entries = [...aliasMap].map(([k, v]) => `${k}->${v}`).join(', ');
      log(`WATCHER: alias map updated: {${entries || '(empty)'}}`);
    }

    // (b) BASE_URL self-heal.
    const cur = settings.env.ANTHROPIC_BASE_URL;
    if (!cur || typeof cur !== 'string') return;
    if (cur === SHIM_URL) return;

    if (!/^https?:\/\//.test(cur)) {
      log(`WATCHER: BASE_URL '${cur}' is not http(s), skip`);
      return;
    }
    if (looksLikeShim(cur)) {
      log(`WATCHER: BASE_URL '${cur}' would self-loop, skip`);
      return;
    }

    if (!setUpstream(cur)) {
      log(`WATCHER: setUpstream rejected '${cur}', skip`);
      return;
    }
    persistLastUpstream(cur);
    settings.env.ANTHROPIC_BASE_URL = SHIM_URL;
    try {
      atomicWriteSettings(settings);
      log(`WATCHER: BASE_URL changed externally -> ${cur}; rebound upstream and rewrote settings.json back to ${SHIM_URL}`);
    } catch (e) {
      log(`WATCHER: failed to rewrite settings.json: ${e.message}`);
    }
  } catch (e) {
    log(`WATCHER: tick error: ${e.message}`);
  } finally {
    watcherBusy = false;
    const _elapsed = Date.now() - _tickStart;
    if (_elapsed > WATCH_INTERVAL_MS * 0.8) {
      log(`WATCHER: slow tick ${_elapsed}ms (threshold ${WATCH_INTERVAL_MS}ms)`);
    }
  }
}

function startSettingsWatcher() {
  if (!WATCH_ENABLED) {
    log(`WATCHER: disabled via SHIM_WATCH_SETTINGS=0`);
    return;
  }
  log(`WATCHER: polling ${SETTINGS_PATH} every ${WATCH_INTERVAL_MS}ms`);
  watcherTick();
  watcherTimer = setInterval(watcherTick, WATCH_INTERVAL_MS);
  if (watcherTimer.unref) watcherTimer.unref();
}

const server = http.createServer((req, res) => {
  // /health — status endpoint for monitoring and debugging.
  if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
    const body = JSON.stringify({
      status:    'ok',
      uptime:    Math.floor((Date.now() - START_TIME) / 1000),
      upstream:  CURRENT_UPSTREAM,
      targets:   TARGET_MODELS,
      candidateTargets: Array.from(candidateTargets),
      aliasMap:  Object.fromEntries(aliasMap),
      stats
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  const chunks = [];
  let totalSize = 0;
  req.on('data', c => {
    totalSize += c.length;
    if (totalSize > MAX_BODY_SIZE) {
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'payload_too_large', message: `request body exceeds ${MAX_BODY_SIZE} bytes` }
        }));
      }
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', err => { log(`CLIENT ERROR: ${err.message}`); try { res.destroy(); } catch (_) {} });
  req.on('end', () => {
    let bodyBuf = Buffer.concat(chunks);
    const pathOnly = req.url.split('?')[0];
    const isMessages = req.method === 'POST' && pathOnly.endsWith('/v1/messages');
    let note = 'passthrough';
    let responseTargetIsDeepseek = false;

    if (isMessages && bodyBuf.length) {
      try {
        const body = JSON.parse(bodyBuf.toString('utf8'));
        const label = body.model || '';
        const real  = resolveRealModel(label);
        const rewroteModel = (real !== label);
        const targetIsDeepseek = isDeepseek(real);
        responseTargetIsDeepseek = targetIsDeepseek;

        // Rewrite body.model to the real model name so upstream actually
        // calls the model the user configured in _MODEL_NAME.
        if (rewroteModel) {
          body.model = real;
        }

        if (targetIsDeepseek) {
          if (DUMP) log(`  msgs ${real}: ${summarize(body)}`);
          const n = fixThinkingRoundtrip(body);
          const rewriteSuffix = rewroteModel ? ` (rewrote ${label} -> ${real})` : '';
          if (n > 0 || rewroteModel) {
            bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
          }
          if (n > 0) {
            note = `FIXED: injected ${n} thinking block(s) [model=${real}]${rewriteSuffix}`;
          } else {
            note = `no-op [model=${real}]${rewriteSuffix}`;
          }
        } else {
          // Non-deepseek: rewrite model if alias points elsewhere, but do
          // NOT inject thinking or modify anything else.
          if (rewroteModel) {
            bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
            note = `untouched [model=${real}] (rewrote ${label} -> ${real})`;
          } else {
            note = `untouched [model=${label}]`;
          }
        }
      } catch (e) {
        note = `parse-error, forwarding original: ${e.message}`;
        stats.errors++;
      }
    }
    stats.total++;
    if (note.startsWith('FIXED'))     stats.fixed++;
    else if (note.startsWith('no-op')) stats.noop++;
    else if (note.startsWith('untouched') || note === 'passthrough') stats.untouched++;
    log(`${req.method} ${pathOnly} -> ${note}`);

    const headers = Object.assign({}, req.headers);
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    headers['host'] = UP.hostname + (UP.port ? `:${UP.port}` : '');
    headers['content-length'] = Buffer.byteLength(bodyBuf);

    const upReq = upstreamModule.request(
      {
        host: UP.hostname,
        port: UP_PORT,
        method: req.method,
        path: req.url,
        headers
      },
      upRes => {
        clearTimeout(upTimer); // upstream responded — cancel pre-response timeout
        const contentType = String(upRes.headers['content-type'] || '');
        const isSse = /text\/event-stream/i.test(contentType);

        if (!isSse) {
          // Non-streaming: buffer full response, rewrite thinking signatures if needed.
          if (!responseTargetIsDeepseek) {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
            return;
          }
          const respChunks = [];
          upRes.on('data', c => respChunks.push(c));
          upRes.on('end', () => {
            const respBuf = Buffer.concat(respChunks);
            let finalBuf = respBuf;
            try {
              const respBody = JSON.parse(respBuf.toString('utf8'));
              const n = rewriteJsonThinkingSignatures(respBody);
              if (n > 0) {
                finalBuf = Buffer.from(JSON.stringify(respBody), 'utf8');
                stats.sseRewritten += n;
                log(`RESPONSE: cleared ${n} thinking signature(s) [non-stream]`);
              }
            } catch (_) { /* not JSON or no thinking blocks — fine */ }
            const outHeaders = Object.assign({}, upRes.headers);
            if (finalBuf !== respBuf) {
              outHeaders['content-length'] = String(finalBuf.length);
            }
            res.writeHead(upRes.statusCode, outHeaders);
            res.end(finalBuf);
          });
          upRes.on('error', err => {
            log(`UPSTREAM RESP ERROR: ${err.message}`);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
          });
          return;
        }

        // SSE response-side signature normalization for deepseek-family models.
        const outHeaders = Object.assign({}, upRes.headers);
        delete outHeaders['content-length'];
        outHeaders['transfer-encoding'] = 'chunked';
        res.writeHead(upRes.statusCode, outHeaders);

        const rewriter = createSseRewriter(true);
        upRes.on('data', chunk => {
          for (const part of rewriter.push(chunk)) {
            res.write(part, 'utf8');
          }
        });
        upRes.on('end', () => {
          const tail = rewriter.flush();
          if (tail) res.write(tail, 'utf8');
          const n = rewriter.getRewritten();
          if (n > 0) {
            stats.sseRewritten += n;
            log(`RESPONSE: cleared ${n} thinking signature(s) [stream]`);
          }
          res.end();
        });
        upRes.on('error', err => {
          log(`UPSTREAM SSE ERROR (${UP_IS_TLS ? 'https' : 'http'}://${UP.hostname}:${UP_PORT}): ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'proxy_error', message: `shim upstream sse error: ${err.message}` }
            }));
          } else {
            res.end();
          }
        });
      }
    );
    upReq.on('error', err => {
      log(`UPSTREAM ERROR (${UP_IS_TLS ? 'https' : 'http'}://${UP.hostname}:${UP_PORT}): ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `shim upstream error: ${err.message}` }
      }));
    });

    // Upstream timeout guard — only applies until first response byte arrives.
    // Default 5 min. Thinking/reasoning requests can legitimately take minutes.
    // Once upRes fires (stream begins), the timer is cleared so a long SSE
    // stream is never cut off mid-flight by the pre-response timeout.
    const UP_TIMEOUT = parseInt(process.env.SHIM_UPSTREAM_TIMEOUT || '300000', 10);
    const upTimer = setTimeout(() => {
      upReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'upstream_timeout', message: `upstream did not respond within ${UP_TIMEOUT}ms` }
        }));
      }
      log(`UPSTREAM TIMEOUT after ${UP_TIMEOUT}ms -> ${CURRENT_UPSTREAM}`);
    }, UP_TIMEOUT);

    upReq.end(bodyBuf);
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`deepseek-think-fix listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  log(`  upstream:  ${CURRENT_UPSTREAM}  (${UP_IS_TLS ? 'HTTPS' : 'HTTP'})`);
  log(`  targets:   ${TARGET_MODELS.join(', ')}`);
  if (staticRewriteMap.size > 0) {
    const rules = [...staticRewriteMap].map(([k, v]) => `${k}->${v}`).join(', ');
    log(`  rewrite:   ${rules}`);
  }
  startSettingsWatcher();
});
