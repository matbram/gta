#!/usr/bin/env bash
set -euo pipefail

if [ -z "${ADH_API_URL:-}" ] || [ -z "${ADH_PROJECT_TOKEN:-}" ]; then
  printf '%s\n' 'ADH_API_URL and ADH_PROJECT_TOKEN are required in the Claude environment.' >&2
  exit 1
fi

root="${CLAUDE_PROJECT_DIR:-$PWD}"
payload="$(cat)"
printf '%s' "$payload" | python3 -c 'import json,sys; value=json.load(sys.stdin); assert isinstance(value, dict)' >/dev/null

session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then
  git_state_path="$(git -C "$root" rev-parse --git-path adh/session-id 2>/dev/null || true)"
  if [ -n "$git_state_path" ]; then
    case "$git_state_path" in
      /*) session_file="$git_state_path" ;;
      *) session_file="$root/$git_state_path" ;;
    esac
    session_id="$(cat "$session_file" 2>/dev/null || true)"
  fi
fi

repository="$(python3 - "$root/.adh/config.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8")).get("repository", "")
if not isinstance(value, str) or value.count("/") != 1:
    raise SystemExit("ADH repository binding is missing")
print(value)
PY
)"

curl --fail --silent --show-error --max-time 10 \
  --request POST \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header "X-ADH-Repository: ${repository}" \
  --header 'X-ADH-Connector-Version: 4' \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/session-captures"
