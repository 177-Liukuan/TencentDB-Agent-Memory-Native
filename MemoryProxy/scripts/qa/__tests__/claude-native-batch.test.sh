#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_UNDER_TEST="$(cd -- "$SCRIPT_DIR/.." && pwd)/claude-native-batch.sh"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf -- "$TEST_TMP"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label: expected '$expected', got '$actual'"
}

FAKE_LAUNCHER="$TEST_TMP/claude-native"
CAPTURE_ARGS="$TEST_TMP/args"
export CAPTURE_ARGS

cat >"$FAKE_LAUNCHER" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" >"$CAPTURE_ARGS"
FAKE
chmod +x "$FAKE_LAUNCHER"

CLAUDE_NATIVE_LAUNCHER="$FAKE_LAUNCHER" \
  "$LAUNCHER_UNDER_TEST" \
  --team-id team-123 \
  --agent-id agt-456 \
  --task-id task-789 \
  --session-id 11111111-1111-4111-8111-111111111111 \
  'retrieve memory'

mapfile -d '' -t args <"$CAPTURE_ARGS"
expected_settings='{"env":{"ANTHROPIC_CUSTOM_HEADERS":"x-team-id: team-123\nx-agent-id: agt-456\nx-task-id: task-789"}}'
assert_eq '9' "${#args[@]}" 'argument count'
assert_eq '--settings' "${args[0]}" 'settings flag'
assert_eq "$expected_settings" "${args[1]}" 'identity settings'
assert_eq '--session-id' "${args[2]}" 'session flag'
assert_eq '11111111-1111-4111-8111-111111111111' "${args[3]}" 'session value'
assert_eq '-p' "${args[4]}" 'print flag'
assert_eq '--output-format' "${args[5]}" 'output flag'
assert_eq 'json' "${args[6]}" 'default output format'
assert_eq '--' "${args[7]}" 'argument separator'
assert_eq 'retrieve memory' "${args[8]}" 'prompt'

printf 'PASS: forwards validated identity in non-interactive JSON mode\n'

rm -f -- "$CAPTURE_ARGS"
set +e
missing_output="$(
  CLAUDE_NATIVE_LAUNCHER="$FAKE_LAUNCHER" \
    "$LAUNCHER_UNDER_TEST" \
    --team-id team-123 \
    --agent-id agt-456 \
    'retrieve memory' 2>&1
)"
missing_rc=$?
set -e
assert_eq '2' "$missing_rc" 'missing identity exit code'
[[ "$missing_output" == *'--task-id is required'* ]] || fail 'missing task diagnostic'
[[ ! -e "$CAPTURE_ARGS" ]] || fail 'missing identity must not invoke Claude Code'
printf 'PASS: rejects incomplete identity before invoking Claude Code\n'

set +e
invalid_output="$(
  CLAUDE_NATIVE_LAUNCHER="$FAKE_LAUNCHER" \
    "$LAUNCHER_UNDER_TEST" \
    --team-id $'team-123\nx-evil: injected' \
    --agent-id agt-456 \
    --task-id task-789 \
    'retrieve memory' 2>&1
)"
invalid_rc=$?
set -e
assert_eq '2' "$invalid_rc" 'invalid identity exit code'
[[ "$invalid_output" == *'invalid --team-id'* ]] || fail 'invalid identity diagnostic'
[[ ! -e "$CAPTURE_ARGS" ]] || fail 'invalid identity must not invoke Claude Code'
printf 'PASS: rejects values that could inject extra HTTP headers\n'

CLAUDE_NATIVE_LAUNCHER="$FAKE_LAUNCHER" \
  "$LAUNCHER_UNDER_TEST" \
  --team-id team-123 \
  --agent-id agt-456 \
  --task-id task-789 \
  'retrieve memory'

mapfile -d '' -t generated_args <"$CAPTURE_ARGS"
[[ "${generated_args[3]}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || \
  fail "generated session is not a UUID: '${generated_args[3]}'"
printf 'PASS: generates an isolated session by default\n'
