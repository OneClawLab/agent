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

source "$(dirname "$0")/scripts/e2e-lib.sh"

AGENT="agent"
AID="e2e-test-$$"
AGENT_DIR="${THECLAW_HOME:-$HOME/.theclaw}/agents/$AID"

on_cleanup() {
  rm -rf "$AGENT_DIR"
}

setup_e2e

# ── Pre-flight ────────────────────────────────────────────────
section "Pre-flight"

require_bin $AGENT "run npm run build"
require_bin thread "run: cd ../thread && npm run release:local"

PROVIDER=$(pai model default --json 2>/dev/null | json_field_from_stdin "defaultProvider")
if [[ -z "$PROVIDER" ]]; then fail "No default provider — run: pai model default --name <provider>"; exit 1; fi
pass "Default provider: $PROVIDER"

# ══════════════════════════════════════════════════════════════
# 1. init
# ══════════════════════════════════════════════════════════════
section "1. init"
run_cmd $AGENT init "$AID"
assert_exit0
assert_file_exists "$AGENT_DIR/config.yaml" "config.yaml"
assert_file_exists "$AGENT_DIR/IDENTITY.md" "IDENTITY.md"
assert_file_exists "$AGENT_DIR/inbox/events.db" "inbox thread"

# ══════════════════════════════════════════════════════════════
# 2. init — duplicate exits 1
# ══════════════════════════════════════════════════════════════
section "2. init — duplicate"
run_cmd $AGENT init "$AID"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# 3. list
# ══════════════════════════════════════════════════════════════
section "3. list"
run_cmd $AGENT list
assert_exit0
assert_contains "$AID"

# ══════════════════════════════════════════════════════════════
# 4. list --json
# ══════════════════════════════════════════════════════════════
section "4. list --json"
run_cmd $AGENT list --json
assert_exit0
assert_json_array

# ══════════════════════════════════════════════════════════════
# 5. status (all agents)
# ══════════════════════════════════════════════════════════════
section "5. status"
run_cmd $AGENT status
assert_exit0
assert_contains "$AID"

# ══════════════════════════════════════════════════════════════
# 6. status <id>
# ══════════════════════════════════════════════════════════════
section "6. status <id>"
run_cmd $AGENT status "$AID"
assert_exit0
assert_nonempty

# ══════════════════════════════════════════════════════════════
# 7. status <id> --json
# ══════════════════════════════════════════════════════════════
section "7. status <id> --json"
run_cmd $AGENT status "$AID" --json
assert_exit0
assert_json_field "$OUT" "id"

# ══════════════════════════════════════════════════════════════
# 8. start
# ══════════════════════════════════════════════════════════════
section "8. start"
run_cmd $AGENT start "$AID"
assert_exit0
INBOX_INFO=$(thread info --thread "$AGENT_DIR/inbox" 2>/dev/null || true)
echo "$INBOX_INFO" | grep -q "inbox" && pass "inbox subscription registered" || fail "inbox subscription missing"

# ══════════════════════════════════════════════════════════════
# 9. send
# ══════════════════════════════════════════════════════════════
section "9. send"
run_cmd $AGENT send "$AID" --source "e2e" --type "message" --content '{"text":"hello from e2e"}'
assert_exit0
INBOX_COUNT=$(thread peek --thread "$AGENT_DIR/inbox" --last-event-id 0 2>/dev/null | wc -l | tr -d ' ')
[[ "$INBOX_COUNT" -ge 1 ]] && pass "event in inbox (count: $INBOX_COUNT)" || fail "inbox empty after send"

# ══════════════════════════════════════════════════════════════
# 10. send — with subtype
# ══════════════════════════════════════════════════════════════
section "10. send — with subtype"
run_cmd $AGENT send "$AID" --source "e2e" --type "record" --subtype "toolcall" \
  --content '{"tool":"bash","args":["echo hi"]}'
assert_exit0

# ══════════════════════════════════════════════════════════════
# 11. stop
# ══════════════════════════════════════════════════════════════
section "11. stop"
run_cmd $AGENT stop "$AID"
assert_exit0
INBOX_INFO=$(thread info --thread "$AGENT_DIR/inbox" 2>/dev/null || true)
echo "$INBOX_INFO" | grep -q "^  - inbox" \
  && fail "inbox subscription still present after stop" \
  || pass "inbox subscription removed"

# ══════════════════════════════════════════════════════════════
# 12. Error — operations on non-existent agent exit 1
# ══════════════════════════════════════════════════════════════
section "12. Error — operations on non-existent agent"
run_cmd $AGENT start "no-such-agent-$"; assert_exit 1
run_cmd $AGENT stop  "no-such-agent-$"; assert_exit 1
run_cmd $AGENT status "no-such-agent-$"; assert_exit 1

summary_and_exit
