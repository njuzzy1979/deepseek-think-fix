#!/usr/bin/env node
'use strict';

// Alias-map unit tests — runs independently of the live shim.
// Tests buildAliasMapFromSettings() with all three field patterns:
//   ANTHROPIC_DEFAULT_<SLOT>_MODEL / _MODEL_NAME
//   ANTHROPIC_REASONING_MODEL      / _REASONING_MODEL_NAME
//   ANTHROPIC_MODEL                / _MODEL_NAME

let pass = 0, fail = 0;
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  PASS  ' + label);
    pass++;
  } else {
    console.log('  FAIL  ' + label + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
    fail++;
  }
}

// Inline copies of shim helpers (must be kept in sync with shim.js).
function stripBracketSuffix(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/(?:\[.*?\])+\s*$/, '').trim();
}

function buildAliasMapFromSettings(settings) {
  const next = new Map();
  const env = settings && settings.env;
  if (!env || typeof env !== 'object') return next;
  function addPair(label, real) {
    label = stripBracketSuffix(label);
    real  = stripBracketSuffix(real);
    if (!label || !real) return;
    if (label === real) return;
    next.set(label, real);
  }
  for (const key of Object.keys(env)) {
    const m = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL$/);
    if (m) {
      addPair(env[key], env[`ANTHROPIC_DEFAULT_${m[1]}_MODEL_NAME`] || '');
      continue;
    }
    if (key === 'ANTHROPIC_REASONING_MODEL') {
      addPair(env[key], env['ANTHROPIC_REASONING_MODEL_NAME'] || '');
    }
    if (key === 'ANTHROPIC_MODEL') {
      addPair(env[key], env['ANTHROPIC_MODEL_NAME'] || '');
    }
  }
  return next;
}

console.log('\n--- F. Alias Map Unit Tests ---');

// F1-F3: DEFAULT slot pairs
const mapSlot = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_DEFAULT_OPUS_MODEL':      'claude-label-opus',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME': 'deepseek-v4-pro-guan-cc',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL':     'claude-label-haiku',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME':'deepseek-v4-pro-guan-cc',
}});
check('F1 DEFAULT_OPUS alias built',   mapSlot.get('claude-label-opus'),   'deepseek-v4-pro-guan-cc');
check('F2 DEFAULT_HAIKU alias built',  mapSlot.get('claude-label-haiku'),  'deepseek-v4-pro-guan-cc');
check('F3 identity pair skipped',      mapSlot.has('deepseek-v4-pro-guan-cc'), false);

// F4-F5: REASONING_MODEL pair
const mapReasoning = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_REASONING_MODEL':      'claude-label-reasoning',
  'ANTHROPIC_REASONING_MODEL_NAME': 'deepseek-v4-pro-guan-cc',
}});
check('F4 REASONING alias built',   mapReasoning.get('claude-label-reasoning'), 'deepseek-v4-pro-guan-cc');
check('F5 REASONING map size = 1',  mapReasoning.size, 1);

// F6-F7: ANTHROPIC_MODEL pair (N1)
const mapModel = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_MODEL':      'claude-label-model',
  'ANTHROPIC_MODEL_NAME': 'deepseek-v4-pro-guan-cc',
}});
check('F6 ANTHROPIC_MODEL alias built',  mapModel.get('claude-label-model'), 'deepseek-v4-pro-guan-cc');
check('F7 ANTHROPIC_MODEL map size = 1', mapModel.size, 1);

// F8: ANTHROPIC_MODEL identity (no _NAME field) → no entry
const mapModelDirect = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_MODEL': 'deepseek-v4-pro-guan-cc',
}});
check('F8 ANTHROPIC_MODEL identity skipped (no _NAME)', mapModelDirect.size, 0);

// F9: bracket suffix stripped before mapping
const mapBracket = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_DEFAULT_SONNET_MODEL':      'deepseek-v4-pro[1M]',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME': 'deepseek-v4-pro',
}});
check('F9 bracket suffix stripped → identity skipped', mapBracket.size, 0);

// F10: multi-bracket suffix
const mapMultiBracket = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_DEFAULT_SONNET_MODEL':      'my-label',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME': 'deepseek-v4[1M][legacy]',
}});
check('F10 multi-bracket NAME stripped', mapMultiBracket.get('my-label'), 'deepseek-v4');

// F11: all three field types in one settings object
const mapAll = buildAliasMapFromSettings({ env: {
  'ANTHROPIC_DEFAULT_OPUS_MODEL':      'label-opus',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME': 'deepseek-v4-pro-guan-cc',
  'ANTHROPIC_REASONING_MODEL':         'label-reasoning',
  'ANTHROPIC_REASONING_MODEL_NAME':    'deepseek-v4-pro-guan-cc',
  'ANTHROPIC_MODEL':                   'label-model',
  'ANTHROPIC_MODEL_NAME':              'deepseek-v4-pro-guan-cc',
}});
check('F11 all three types, size = 3', mapAll.size, 3);
check('F11 OPUS alias',      mapAll.get('label-opus'),      'deepseek-v4-pro-guan-cc');
check('F11 REASONING alias', mapAll.get('label-reasoning'), 'deepseek-v4-pro-guan-cc');
check('F11 MODEL alias',     mapAll.get('label-model'),     'deepseek-v4-pro-guan-cc');

console.log(`\n  F TOTAL: PASS=${pass}  FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
