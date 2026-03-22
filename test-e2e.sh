#!/usr/bin/env bash
#
# agent CLI End-to-End Test Script — core functionality
#
# Prerequisites:
#   - agent built: npm run build  (uses node dist/index.js)
#   - thread installed globally: npm run release:local (in thread repo)
#   - pai installed globally with a default provider configured
#     (agent run calls pai chat internally)
#   - Check: pai model default --json  → must have defaultProvider
#
# Usage: bash test-e2e.sh
#
set -uo pipefail

AGENT="agent"
TD=$(mktemp -d)
PASS=0; FAIL=0
AID="e2e-test-$$"
AGENT_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID"

cleanup() {
  rm -rf "$TD"
  rm -rf "$AGENT_DIR"
}
trap cleanup EXIT

G() { printf "\033[32m  ✓ %s\033[0m\n" "$*"; PASS=$((PASS+1)); }
R() { printf "\033[31m  ✗ %s\033[0m\n" "$*"; FAIL=$((FAIL+1)); }
S() { echo ""; printf "\033[33m━━ %s ━━\033[0m\n" "$*"; }

# ── Pre-flight ────────────────────────────────────────────────
S "Pre-flight"
if $AGENT --version >/dev/null 2>&1; then G "agent binary OK"; else R "agent broken — run npm run build"; exit 1; fi
if thread --version >/dev/null 2>&1; then G "thread binary OK"; else R "thread not installed — run: cd ../thread && npm run release:local"; exit 1; fi

DEFAULT_JSON=$(pai model default --json 2>/dev/null || true)
PROVIDER=$(echo "$DEFAULT_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).defaultProvider ?? '')" 2>/dev/null || true)
[[ -n "$PROVIDER" ]] && G "Default provider: $PROVIDER" || { R "No default provider — run: pai model default --name <provider>"; exit 1; }

# ══════════════════════════════════════════════════════════════
# 1. init
# ══════════════════════════════════════════════════════════════
S "1. init"
$AGENT init "$AID" >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
[[ -d "$AGENT_DIR" ]] && G "agent directory created" || R "agent directory missing"
[[ -f "$AGENT_DIR/config.yaml" ]] && G "config.yaml created" || R "config.yaml missing"
[[ -f "$AGENT_DIR/IDENTITY.md" ]] && G "IDENTITY.md created" || R "IDENTITY.md missing"
[[ -f "$AGENT_DIR/inbox/events.db" ]] && G "inbox thread initialized" || R "inbox thread missing"

# ══════════════════════════════════════════════════════════════
# 2. init — duplicate exits 1
# ══════════════════════════════════════════════════════════════
S "2. init — duplicate"
$AGENT init "$AID" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "exit=1 for duplicate init" || R "exit=$EC (expected 1)"

# ══════════════════════════════════════════════════════════════
# 3. list
# ══════════════════════════════════════════════════════════════
S "3. list"
OUT="$TD/3.txt"
$AGENT list >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
grep -q "$AID" "$OUT" && G "agent appears in list" || R "agent missing from list"

# ══════════════════════════════════════════════════════════════
# 4. list --json
# ══════════════════════════════════════════════════════════════
S "4. list --json"
OUT="$TD/4.txt"
$AGENT list --json >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
if node -e "const d=JSON.parse(require('fs').readFileSync('$OUT','utf8')); if(!Array.isArray(d)) throw 0" 2>/dev/null; then
  G "valid JSON array"
else
  R "invalid JSON or not an array"
fi

# ══════════════════════════════════════════════════════════════
# 5. status (all agents)
# ══════════════════════════════════════════════════════════════
S "5. status"
OUT="$TD/5.txt"
$AGENT status >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
grep -q "$AID" "$OUT" && G "agent appears in status" || R "agent missing from status"

# ══════════════════════════════════════════════════════════════
# 6. status <id>
# ══════════════════════════════════════════════════════════════
S "6. status <id>"
OUT="$TD/6.txt"
$AGENT status "$AID" >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
[[ -s "$OUT" ]] && G "status output non-empty" || R "status output empty"

# ══════════════════════════════════════════════════════════════
# 7. status <id> --json
# ══════════════════════════════════════════════════════════════
S "7. status <id> --json"
OUT="$TD/7.txt"
$AGENT status "$AID" --json >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
if node -e "const d=JSON.parse(require('fs').readFileSync('$OUT','utf8')); if(!d.id) throw 0" 2>/dev/null; then
  G "valid JSON with id field"
else
  R "invalid JSON or missing id field"
fi

# ══════════════════════════════════════════════════════════════
# 8. start
# ══════════════════════════════════════════════════════════════
S "8. start"
$AGENT start "$AID" >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
# Verify subscription was registered via thread info
INBOX_PATH="$AGENT_DIR/inbox"
INFO=$(thread info --thread "$INBOX_PATH" 2>/dev/null || true)
echo "$INFO" | grep -q "inbox" && G "inbox subscription registered" || R "inbox subscription missing"

# ══════════════════════════════════════════════════════════════
# 9. send — push event to inbox
# ══════════════════════════════════════════════════════════════
S "9. send"
$AGENT send "$AID" \
  --source "e2e" \
  --type "message" \
  --content '{"text":"hello from e2e"}' >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
# Verify event landed in inbox
INBOX_COUNT=$(thread peek --thread "$INBOX_PATH" --last-event-id 0 2>/dev/null | wc -l | tr -d ' ')
[[ "$INBOX_COUNT" -ge 1 ]] && G "event in inbox (count: $INBOX_COUNT)" || R "inbox empty after send"

# ══════════════════════════════════════════════════════════════
# 10. send — with subtype
# ══════════════════════════════════════════════════════════════
S "10. send — with subtype"
$AGENT send "$AID" \
  --source "e2e" \
  --type "record" \
  --subtype "toolcall" \
  --content '{"tool":"bash","args":["echo hi"]}' >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"

# ══════════════════════════════════════════════════════════════
# 11. stop
# ══════════════════════════════════════════════════════════════
S "11. stop"
$AGENT stop "$AID" >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
# Verify subscription was removed
INFO=$(thread info --thread "$INBOX_PATH" 2>/dev/null || true)
echo "$INFO" | grep -q "inbox" && R "inbox subscription still present after stop" || G "inbox subscription removed"

# ══════════════════════════════════════════════════════════════
# 12. Error — init unknown agent operations exit 1
# ══════════════════════════════════════════════════════════════
S "12. Error — operations on non-existent agent"
$AGENT start "no-such-agent-$$" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "start non-existent → exit=1" || R "exit=$EC (expected 1)"

$AGENT stop "no-such-agent-$$" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "stop non-existent → exit=1" || R "exit=$EC (expected 1)"

$AGENT status "no-such-agent-$$" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "status non-existent → exit=1" || R "exit=$EC (expected 1)"

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
S "Results"
echo ""
TOTAL=$((PASS + FAIL))
printf "  Passed: \033[32m%d\033[0m\n" "$PASS"
printf "  Failed: %s\n" "$( [[ $FAIL -gt 0 ]] && printf "\033[31m%d\033[0m" "$FAIL" || echo 0 )"
echo "  Total:  $TOTAL"
echo ""
[[ $FAIL -eq 0 ]] && printf "\033[32mAll tests passed!\033[0m\n" && exit 0
printf "\033[31mSome tests failed.\033[0m\n" && exit 1
