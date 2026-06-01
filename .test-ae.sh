#!/bin/bash
set +e

SHIMLOG=/e/Program/deepseek-think-fix/shim.log
PASS=0; FAIL=0

mark_pass() { PASS=$((PASS+1)); echo "  PASS  $1"; }
mark_fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1 -- $2"; }

last_note() {
  tail -1 "$SHIMLOG" | grep -oE "FIXED|untouched|no-op|parse-error"
}

last_inject_count() {
  tail -1 "$SHIMLOG" | grep -oE "injected [0-9]+ thinking" | grep -oE "[0-9]+"
}

send_body() {
  curl -s -o /dev/null -X POST http://127.0.0.1:8788/v1/messages \
    -H "content-type: application/json" -H "x-api-key: dummy" \
    -d "$1" --max-time 5
  sleep 0.2
}

check_model() {
  local model="$1"; local want="$2"; local label="$3"
  local body="{\"model\":\"$model\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"x\",\"input\":{}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}]}"
  send_body "$body"
  local got=$(last_note)
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

send_body '{"model":"deepseek-v4-pro","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
got=$(last_note)
[ "$got" = "no-op" ] && mark_pass "C1 deepseek single turn no tool_use -> no-op" || mark_fail "C1" "got $got"

send_body '{"model":"deepseek-v4-pro","max_tokens":64,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}'
got=$(last_note)
[ "$got" = "no-op" ] && mark_pass "C2 deepseek with existing thinking -> no-op (no double-inject)" || mark_fail "C2" "got $got"

send_body '{"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
got=$(last_note)
[ "$got" = "untouched" ] && mark_pass "C3 empty model -> untouched" || mark_fail "C3" "got $got"

curl -s -o /dev/null -X POST http://127.0.0.1:8788/v1/messages \
  -H "content-type: application/json" -H "x-api-key: dummy" \
  -d '{broken-json' --max-time 5
sleep 0.2
got=$(last_note)
[ "$got" = "parse-error" ] && mark_pass "C4 malformed JSON -> parse-error safe forward" || mark_fail "C4" "got $got"

send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q1"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r1"}]},{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"r2"}]}]}'
got=$(last_inject_count)
[ "$got" = "2" ] && mark_pass "C5 three turns multi tool_use -> injected 2" || mark_fail "C5" "injected $got, want 2"

send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q1"},{"role":"assistant","content":[{"type":"thinking","thinking":"x","signature":"s"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"r1"}]},{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"r2"}]}]}'
got=$(last_inject_count)
[ "$got" = "1" ] && mark_pass "C6 mixed: turn1 has thinking, turn2 missing -> only inject 1" || mark_fail "C6" "injected $got, want 1"

got=$(curl -s -o /dev/null -w "%{http_code}" -I http://127.0.0.1:8788/ --max-time 5)
[ -n "$got" ] && [ "$got" != "000" ] && mark_pass "C7 HEAD / health probe (HTTP $got)" || mark_fail "C7" "got $got"

echo ""
echo "--- D. SSE Streaming ---"
send_body '{"model":"deepseek-v4-pro-guan-cc","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}'
got=$(last_note)
[ "$got" = "FIXED" ] && mark_pass "D1 stream=true still identifies and injects" || mark_fail "D1" "note=$got"

echo ""
echo "--- E. Message Shape Variations ---"
send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"plain string"}]}]}'
got=$(last_note)
[ "$got" = "FIXED" ] && mark_pass "E1 tool_result.content as string" || mark_fail "E1" "got $got"

send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}]}]}]}'
got=$(last_note)
[ "$got" = "FIXED" ] && mark_pass "E2 tool_result.content as array" || mark_fail "E2" "got $got"

send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"text","text":"reasoning"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}'
got=$(last_note)
[ "$got" = "FIXED" ] && mark_pass "E3 assistant has text+tool_use without thinking -> inject" || mark_fail "E3" "got $got"

send_body '{"model":"deepseek","max_tokens":64,"messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"redacted_thinking","data":"xxx"},{"type":"tool_use","id":"t1","name":"x","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}'
got=$(last_note)
[ "$got" = "no-op" ] && mark_pass "E4 redacted_thinking counts as thinking -> no-op" || mark_fail "E4" "got $got"

echo ""
echo "================================================================"
echo "  A-E SUBTOTAL: PASS=$PASS  FAIL=$FAIL"
echo "================================================================"
