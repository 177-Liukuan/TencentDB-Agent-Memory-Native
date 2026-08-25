#!/usr/bin/env bash
set -euo pipefail

CLAUDE_NATIVE_LAUNCHER="${CLAUDE_NATIVE_LAUNCHER:-/storage1/liukuan/tencentdb-memory-lab/bin/claude-native}"

team_id=""
agent_id=""
task_id=""
session_id=""

die() {
  printf 'claude-native-batch: %s\n' "$1" >&2
  exit 2
}

while (( "$#" )); do
  case "$1" in
    --team-id)
      [[ -n "${2-}" ]] || die "$1 requires a value"
      team_id="$2"
      shift 2
      ;;
    --agent-id)
      [[ -n "${2-}" ]] || die "$1 requires a value"
      agent_id="$2"
      shift 2
      ;;
    --task-id)
      [[ -n "${2-}" ]] || die "$1 requires a value"
      task_id="$2"
      shift 2
      ;;
    --session-id)
      [[ -n "${2-}" ]] || die "$1 requires a value"
      session_id="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage:
  claude-native-batch.sh \
    --team-id <team-id> \
    --agent-id <agent-id> \
    --task-id <task-id> \
    [--session-id <uuid>] \
    [--] <prompt>

Runs one non-interactive Claude Code request with a validated asset identity,
an isolated session by default, and JSON output.
USAGE
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -* )
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

[[ -n "$team_id" ]] || die '--team-id is required'
[[ -n "$agent_id" ]] || die '--agent-id is required'
[[ -n "$task_id" ]] || die '--task-id is required'

for identity_arg in team_id agent_id task_id; do
  identity_value="${!identity_arg}"
  [[ "$identity_value" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid --${identity_arg//_/-}: use only letters, digits, '_' and '-'"
done

(( "$#" == 1 )) || die 'exactly one prompt argument is required'
prompt="$1"
[[ -n "$prompt" ]] || die 'prompt must not be empty'

if [[ -z "$session_id" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    session_id="$(uuidgen)"
  else
    session_id="$(< /proc/sys/kernel/random/uuid)"
  fi
fi

[[ "$session_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || \
  die 'invalid --session-id: expected UUID'
[[ -x "$CLAUDE_NATIVE_LAUNCHER" ]] || die "Claude launcher is not executable: $CLAUDE_NATIVE_LAUNCHER"

export ANTHROPIC_CUSTOM_HEADERS=$'x-team-id: '"$team_id"$'\nx-agent-id: '"$agent_id"$'\nx-task-id: '"$task_id"

exec "$CLAUDE_NATIVE_LAUNCHER" \
  --session-id "$session_id" \
  -p \
  --output-format json \
  -- \
  "$prompt"
