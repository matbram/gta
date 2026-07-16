#!/usr/bin/env bash
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
git_cli_path="$(git -C "$root" rev-parse --git-path adh/bin/adh-cloud 2>/dev/null || true)"
case "$git_cli_path" in
  /*) cli="$git_cli_path" ;;
  '') printf '%s\n' 'ADH verifier cache path is unavailable.' >&2; exit 1 ;;
  *) cli="$root/$git_cli_path" ;;
esac
if [ ! -x "$cli" ]; then
  printf '%s\n' 'ADH verifier is not ready. Start a fresh Claude session so the lifecycle hook can cache it.' >&2
  exit 1
fi

if [ -z "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  git_dir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null || true)"
  session_id="$(cat "${git_dir:+$git_dir/adh/session-id}" 2>/dev/null || true)"
  if [ -n "$session_id" ]; then export CLAUDE_CODE_REMOTE_SESSION_ID="$session_id"; fi
fi

cd "$root"
"$cli" detect
"$cli" prepare
"$cli" test
