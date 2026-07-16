#!/usr/bin/env bash
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
exec python3 "$root/.claude/hooks/adh_outbox.py" enqueue-research
