#!/bin/bash
set +e

SHIMLOG="${SHIM_LOG:-$(dirname "$0")/shim.log}"
PASS=0; FAIL=0

mark_pass() { PASS=$((PASS+1)); echo "  PASS  $1"; }
mark_fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1 -- $2"; }

last_note() {
  grep -E "POST /v1/messages -> (FIXED|untouched|no-op|parse-error)" "$SHIMLOG" | tail -1 | grep -oE "FIXED|untouched|no-op|parse-error"
}

last_note_model() {
  # $1 = model string to match in log line
  grep -E "POST /v1/messages -> (FIXED|untouched|no-op|parse-error)" "$SHIMLOG" | grep "\[model=$(echo "$1" | sed 's/\[/\\[/g;s/\]/\\]/g')\]" | tail -1 | grep -oE "FIXED|untouched|no-op|parse-error"
}

# Send a request and return only the note from the line that was just written.
# Uses line-count snapshotting to isolate from concurrent CC traffic.
send_and_note() {
  local before
  before=$(grep -c "POST /v1/messages" "$SHIMLOG" 2>/dev/null || echo 0)
  send_body "$1"
  local after
  after=$(grep -c "POST /v1/messages" "$SHIMLOG" 2>/dev/null || echo 0)
  if [ "$after" -gt "$before" ]; then
    grep "POST /v1/messages" "$SHIMLOG" | tail -$((after - before)) | grep -oE "FIXED|untouched|no-op|parse-error" | tail -1
  fi
}

send_and_inject_count() {
  local before
  before=$(grep -c "POST /v1/messages -> FIXED" "$SHIMLOG" 2>/dev/null || echo 0)
  send_body "$1"
  local after
  after=$(grep -c "POST /v1/messages -> FIXED" "$SHIMLOG" 2>/dev/null || echo 0)
  if [ "$after" -gt "$before" ]; then
    grep "POST /v1/messages -> FIXED" "$SHIMLOG" | tail -1 | grep -oE "injected [0-9]+ thinking" | grep -oE "[0-9]+"
  fi
}

last_inject_count() {
  grep "POST /v1/messages -> FIXED: injected" "$SHIMLOG" | tail -1 | grep -oE "injected [0-9]+ thinking" | grep -oE "[0-9]+"
}

send_body() {
  curl -s -o /dev/null -X POST http://127.0.0.1:8788/v1/messages \
    -H "content-type: application/json" -H "x-api-key: dummy" \
    -d "$1" --max-time 5
  sleep 0.3
}

check_model() {
  local model="$1"; local want="$2"; local label="$3"
  local body="{\"model\":\"$model\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"x\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}]}"
  send_body "$body"
  local got=$(last_note_model "$model")
  if [ "$got" = "$want" ]; then mark_pass "$label '$model' -> $got"
  else mark_fail "$label '$model'" "expected $want, got $got"; fi
}

echo ""
echo "================================================================"
echo "  Comprehensive Test - deepseek-think-fix shim"
echo "  Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "================================================================"

echo ""
echo "--- A. Health Check ---"
PID_SHIM=$(netstat -ano 2>/dev/null | grep ":8788.*LISTENING" | awk '{print $5}' | head -1)
if [ -n "$PID_SHIM" ]; then mark_pass "A1 shim listening on :8788 (PID=$PID_SHIM)"
else mark_fail "A1 shim not listening" ""; fi

BASE=$(cat ~/.claude/settings.json | grep BASE_URL | grep -oE 'http[s]?://[^"]+' | head -1)
if [ "$BASE" = "http://127.0.0.1:8788" ]; then mark_pass "A2 BASE_URL points to shim"
else mark_fail "A2 BASE_URL=$BASE" ""; fi

UPSTREAM=$(grep "upstream:" "$SHIMLOG" | tail -1 | grep -oE 'http[s]?://[^ ]+')
if [ "$UPSTREAM" = "https://www.dmxapi.cn" ]; then mark_pass "A3 shim upstream = https://www.dmxapi.cn"
else mark_fail "A3 upstream=$UPSTREAM" ""; fi

PING=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8788/v1/messages -H "x-api-key: dummy" -H "content-type: application/json" -d '{}' --max-time 5)
if [ "$PING" = "401" ]; then mark_pass "A4 upstream reachable (HTTP 401 = key rejected, connection OK)"
else mark_fail "A4 upstream unreachable status=$PING" ""; fi

echo ""
echo "--- B. Model Identification Matrix ---"
echo "B.1 deepseek family (should FIX)"
check_model "deepseek"                              FIXED "B1a"
check_model "deepseek-v4-pro"                       FIXED "B1b"
check_model "deepseek-v4-pro-guan-cc"               FIXED "B1c"
check_model "deepseek-v4-pro-guan-cc[1M]"           FIXED "B1d-bracket-suffix"
check_model "deepseek-r1-20250528"                  FIXED "B1e-future-version"
check_model "deepseek-coder-v2"                     FIXED "B1f"
check_model "deepseek-chat"                         FIXED "B1g"

echo "B.2 non-deepseek (should be untouched)"
check_model "claude-haiku-4-5"                      untouched "B2a"
check_model "claude-haiku-4-5-20251001"             untouched "B2b-version"
check_model "claude-opus-4-7"                       untouched "B2c"
check_model "claude-opus-4-7-cc"                    untouched "B2d-cc-suffix"
check_model "claude-sonnet-4-6"                     untouched "B2e"
check_model "claude-sonnet-4-6-cc"                  untouched "B2f"
check_model "gpt-4"                                 untouched "B2g-non-anthropic"
check_model "deepseekx"                             untouched "B2h-glued-not-matched"

echo ""
echo "--- C. Boundary Conditions ---"

got=$(send_and_note '{"model":"deepseek-v4-pro","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}')
[ "$got" = "no-op" ] && mark_pass "C1 deepseek single turn no tool_use -> no-op" || mark_fail "C1" "got $got"

got=$(send_and_note '{"model":"deepseek-v4-pro","max_tokens":64,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}')
[ "$got" = "no-op" ] && mark_pass "C2 deepseek with existing thinking -> no-op (no double-inject)" || mark_fail "C2" "got $got"

got=$(send_and_note '{"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}')
[ "$got" = "untouched" ] && mark_pass "C3 empty model -> untouched" || mark_fail "C3" "got $got"

before_c4=$(grep -c "POST /v1/messages" "$SHIMLOG" 2>/dev/null || echo 0)
curl -s -o /dev/null -X POST http://127.0.0.1:8788/v1/messages \
  -H "content-type: application/json" -H "x-api-key: dummy" \
  -d '{broken-json' --max-time 5
sleep 0.3
after_c4=$(grep -c "POST /v1/messages" "$SHIMLOG" 2>/dev/null || echo 0)
got=$(grep "POST /v1/messages" "$SHIMLOG" | tail -$((after_c4 - before_c4)) 2>/dev/null | grep -oE "parse-error" | tail -1)
[ "$got" = "parse-error" ] && mark_pass "C4 malformed JSON -> parse-error safe forward" || mark_fail "C4" "got $got"

got=$(send_and_inject_count '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q1"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r1"}]},{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"r2"}]}]}')
[ "$got" = "2" ] && mark_pass "C5 three turns multi tool_use -> injected 2" || mark_fail "C5" "injected $got, want 2"

got=$(send_and_inject_count '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q1"},{"role":"assistant","content":[{"type":"thinking","thinking":"x","signature":"s"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r1"}]},{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"r2"}]}]}')
[ "$got" = "1" ] && mark_pass "C6 mixed: turn1 has thinking, turn2 missing -> only inject 1" || mark_fail "C6" "injected $got, want 1"

got=$(curl -s -o /dev/null -w "%{http_code}" -I http://127.0.0.1:8788/ --max-time 5)
[ -n "$got" ] && [ "$got" != "000" ] && mark_pass "C7 HEAD / health probe (HTTP $got)" || mark_fail "C7" "got $got"

echo ""
echo "--- D. SSE Streaming ---"
got=$(send_and_note '{"model":"deepseek-v4-pro-guan-cc","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}')
[ "$got" = "FIXED" ] && mark_pass "D1 stream=true still identifies and injects" || mark_fail "D1" "note=$got"

echo ""
echo "--- E. Message Shape Variations ---"
got=$(send_and_note '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"plain string"}]}]}')
[ "$got" = "FIXED" ] && mark_pass "E1 tool_result.content as string" || mark_fail "E1" "got $got"

got=$(send_and_note '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}]}]}]}')
[ "$got" = "FIXED" ] && mark_pass "E2 tool_result.content as array" || mark_fail "E2" "got $got"

got=$(send_and_note '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"text","text":"reasoning"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}')
[ "$got" = "FIXED" ] && mark_pass "E3 assistant has text+tool_use without thinking -> inject" || mark_fail "E3" "got $got"

got=$(send_and_note '{"model":"deepseek-e4-test","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"redacted_thinking","data":"xxx"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}')
[ "$got" = "no-op" ] && mark_pass "E4 redacted_thinking counts as thinking -> no-op" || mark_fail "E4" "got $got"

echo ""
echo "================================================================"
echo "  A-E SUBTOTAL: PASS=$PASS  FAIL=$FAIL"
echo "================================================================"

# ---------------------------------------------------------------------------
# F. Alias map tests — delegates to .test-alias.js (portable Node script).
# ---------------------------------------------------------------------------

echo ""
echo "--- F. Alias Map ---"
ALIAS_OUT=$(node "$(dirname "$0")/.test-alias.js" 2>&1)
echo "$ALIAS_OUT"
if echo "$ALIAS_OUT" | grep -q "FAIL=0"; then
  F_COUNT=$(echo "$ALIAS_OUT" | grep -oE "PASS=[0-9]+" | grep -oE "[0-9]+")
  PASS=$((PASS + F_COUNT))
else
  F_FAIL=$(echo "$ALIAS_OUT" | grep -oE "FAIL=[0-9]+" | grep -oE "[0-9]+")
  F_PASS=$(echo "$ALIAS_OUT" | grep -oE "PASS=[0-9]+" | grep -oE "[0-9]+")
  PASS=$((PASS + F_PASS))
  FAIL=$((FAIL + F_FAIL))
fi

# F-health: /health endpoint checks.
HEALTH=$(curl -s http://127.0.0.1:8788/health --max-time 5)
echo "$HEALTH" | grep -q '"status"'        && mark_pass "F-health /health returns JSON with status field"   || mark_fail "F-health /health" "response: $HEALTH"
echo "$HEALTH" | grep -q '"upstream"'      && mark_pass "F-health /health includes upstream field"          || mark_fail "F-health /health missing upstream" ""
echo "$HEALTH" | grep -q '"stats"'         && mark_pass "F-health /health includes stats field"             || mark_fail "F-health /health missing stats" ""
echo "$HEALTH" | grep -q '"sseRewritten"'  && mark_pass "F-health /health includes sseRewritten counter"    || mark_fail "F-health /health missing sseRewritten" ""

echo ""
echo "================================================================"
echo "  TOTAL: PASS=$PASS  FAIL=$FAIL"
echo "================================================================"
