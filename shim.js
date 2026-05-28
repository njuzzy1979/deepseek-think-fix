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

// label (body.model from CC) → real model name (from _MODEL_NAME).
// Rebuilt from settings.json on every watcher tick and on startup.
let aliasMap = new Map();

function stripBracketSuffix(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\[.*?\]\s*$/, '').trim();
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

// Look up the real model name. If the label is in the alias map, return
// the mapped value; otherwise return the input (so direct deepseek-* names
// pass through unchanged).
function resolveRealModel(labelFromBody) {
  if (!labelFromBody) return labelFromBody;
  if (aliasMap.has(labelFromBody)) return aliasMap.get(labelFromBody);
  return labelFromBody;
}

// Returns true if either the body.model label OR its mapped real name is
// in the deepseek family. Used as the trigger for thinking-block injection.
function isTargetModel(labelFromBody) {
  if (!labelFromBody) return false;
  // Static path: body.model is itself deepseek-*.
  if (isDeepseek(labelFromBody)) return true;
  // Alias path: body.model is a label; its mapped real name is deepseek-*.
  if (aliasMap.has(labelFromBody) && isDeepseek(aliasMap.get(labelFromBody))) return true;
  return false;
}

// Build alias map from CC settings.json env. For every slot, map _MODEL value
// (the label CC sends in body.model) → _MODEL_NAME value (the real model).
function buildAliasMapFromSettings(settings) {
  const next = new Map();
  const env = settings && settings.env;
  if (!env || typeof env !== 'object') return next;
  for (const key of Object.keys(env)) {
    const m = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL$/);
    if (!m) continue;
    const label = stripBracketSuffix(env[key]);
    const realKey = `ANTHROPIC_DEFAULT_${m[1]}_MODEL_NAME`;
    const real = stripBracketSuffix(env[realKey]);
    if (!label || !real) continue;
    if (label === real) continue; // identity mapping is meaningless
    next.set(label, real);
  }
  return next;
}

const LOG_FILE = process.env.SHIM_LOG || path.join(__dirname, 'shim.log');
const VERBOSE  = process.env.SHIM_VERBOSE === '1';
const DUMP     = process.env.SHIM_DUMP === '1';

// L3: log rotation — cap shim.log at ~10 MB. If over, rename with timestamp.
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

// L2: crash guard — catch unhandled errors, log them, then exit so watchdog restarts.
process.on('uncaughtException', err => {
  log(`FATAL uncaughtException: ${err.message}\n${err.stack || '(no stack)'}`);
  setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (reason, _promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
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
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    let raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let settings;
    try { settings = JSON.parse(raw); }
    catch (e) { log(`WATCHER: settings.json parse error, skip: ${e.message}`); return; }
    if (!settings || !settings.env) return;

    // (a) Refresh alias map from settings.json (source of truth).
    //     Every tick rebuilds it from scratch — no stale cache, no disk
    //     persistence. If cc-switch swaps a slot's _MODEL_NAME, the next
    //     tick reflects it within WATCH_INTERVAL_MS.
    const newAlias = buildAliasMapFromSettings(settings);
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
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', err => { log(`CLIENT ERROR: ${err.message}`); try { res.destroy(); } catch (_) {} });
  req.on('end', () => {
    let bodyBuf = Buffer.concat(chunks);
    const pathOnly = req.url.split('?')[0];
    const isMessages = req.method === 'POST' && pathOnly.endsWith('/v1/messages');
    let note = 'passthrough';

    if (isMessages && bodyBuf.length) {
      try {
        const body = JSON.parse(bodyBuf.toString('utf8'));
        const label = body.model || '';
        const real  = resolveRealModel(label);
        const rewroteModel = (real !== label);
        const targetIsDeepseek = isDeepseek(real);

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
      }
    }
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
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
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
  startSettingsWatcher();
});
