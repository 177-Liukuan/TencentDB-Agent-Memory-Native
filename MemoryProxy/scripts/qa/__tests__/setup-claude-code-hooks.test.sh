#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
export CLAUDE_CONFIG_DIR="$TEST_DIR/claude"
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '%s\n' '{"hooks":{"UserPromptSubmit":[{"matcher":"keep","hooks":[{"type":"command","command":"true"}]}]}}' > "$CLAUDE_CONFIG_DIR/settings.json"

bash "$REPO_DIR/scripts/setup-claude-code.sh" --endpoint http://127.0.0.1:18096/claude-code/space --token secret --header-name X-Tdai-User-Key >/dev/null
bash "$REPO_DIR/scripts/setup-claude-code.sh" --endpoint http://127.0.0.1:18096/claude-code/space --token secret --header-name X-Tdai-User-Key >/dev/null
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json" python3 - <<'PY'
import json, os
data=json.load(open(os.environ["SETTINGS"]))
for event in ("UserPromptSubmit", "PreCompact", "PostCompact"):
    tdai=[h for group in data["hooks"][event] for h in group.get("hooks", []) if h.get("url", "").endswith("/hooks/claude-code/context")]
    assert len(tdai) == 1, (event, tdai)
    assert tdai[0]["headers"] == {"X-Tdai-User-Key": "secret"}, (event, tdai)
assert data["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"] == "true"
PY

bash "$REPO_DIR/scripts/setup-claude-code.sh" --uninstall >/dev/null
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json" python3 - <<'PY'
import json, os
data=json.load(open(os.environ["SETTINGS"]))
assert data["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"] == "true"
assert "PreCompact" not in data.get("hooks", {})
assert "PostCompact" not in data.get("hooks", {})
PY
