#!/usr/bin/env bash
set -euo pipefail

if [ -z "${ADH_API_URL:-}" ] || [ -z "${ADH_PROJECT_TOKEN:-}" ]; then
  printf '%s\n' 'ADH_API_URL and ADH_PROJECT_TOKEN are required in the Claude environment.' >&2
  exit 1
fi

root="${CLAUDE_PROJECT_DIR:-$PWD}"
cli="${TMPDIR:-/tmp}/adh-cloud"

if [ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  git_dir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null || true)"
  session_id="$(cat "${git_dir:+$git_dir/adh/session-id}" 2>/dev/null || true)"
  if [ -n "$session_id" ]; then export CLAUDE_CODE_REMOTE_SESSION_ID="$session_id"; fi
fi

curl --fail --location --silent --show-error --max-time 30 \
  "${ADH_API_URL%/}/downloads/adh-x86_64-unknown-linux-gnu" \
  --output "$cli"
chmod 0700 "$cli"

cd "$root"
"$cli" detect
"$cli" prepare
"$cli" test
