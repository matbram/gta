---
name: adh
description: Persist meaningful project checkpoints, decisions, next steps, and risks to the ADH cloud advisory service when completing milestones or discovering durable project information.
---

# ADH cloud continuity

Use ADH after meaningful work, research, a milestone, an architectural decision, discovery of a durable risk, or a clear change in the next action. The deterministic Stop coordinator prompts this automatically and requires one atomic capture before a substantial turn ends. Do not send secrets, raw credentials, raw prompts, hidden reasoning, copied instructions, or large code and log dumps.

## Capture one meaningful turn

Send one JSON object to the committed helper. The `continuity` object is required. Add zero to five `research` dossiers and zero to eight reviewable `suggestions`. This single request is transactional: ADH either saves the entire capture or none of it.

```bash
cat <<'JSON' | bash .claude/skills/adh/scripts/capture.sh
{"continuity":{"goal":"REPLACE_GOAL","success_criteria":["REPLACE_DEFINITION_OF_DONE"],"current_state":"REPLACE_CURRENT_STATE","completed":["REPLACE_COMPLETED"],"in_progress":[],"next_actions":["REPLACE_NEXT_ACTION"],"blockers":[],"open_questions":[],"constraints":[],"failed_attempts":[],"active_files":["REPLACE_PATH"],"research_refs":[],"verification":{"status":"unknown","summary":null,"commit_sha":null}},"research":[],"suggestions":[]}
JSON
```

Capture the context that would be expensive, frustrating, or dangerous to reconstruct after compaction:

- the real objective, the user's definition of done, current state, exact next move, blockers, unanswered questions, constraints, preferences, active files, and verification state;
- completed milestones and failed approaches, including why an approach failed and what evidence would justify trying it again;
- researched questions, source URLs and titles, discrete findings, conclusions, caveats, contradictions, implications, freshness, and unresolved questions;
- only genuinely durable memory suggestions: a decision with its rationale, a root cause with prevention, an unresolved risk with impact or mitigation, a stable user constraint, or a specific still-relevant next action.

Do not suggest routine test output, temporary progress, feature inventories, speculative backlog, raw logs, or facts already represented in the structured handoff. Research remains evidence; it does not silently become a project decision. After a successful JSON receipt, finish the response without mentioning this internal capture.

## Legacy individual endpoints

Connector version 4 uses the atomic capture above. The individual endpoints below remain available only for older connector copies and deliberate repair. Include only fields known from the conversation; omit or use empty arrays for unknowns.

```bash
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then session_id="$(cat "$(git rev-parse --git-path adh/session-id)" 2>/dev/null || true)"; fi
payload='{"goal":"REPLACE_GOAL","success_criteria":["REPLACE_CRITERION"],"current_state":"REPLACE_CURRENT_STATE","completed":["REPLACE_COMPLETED"],"in_progress":[],"next_actions":["REPLACE_NEXT_ACTION"],"blockers":[],"open_questions":[],"constraints":[],"failed_attempts":[],"active_files":["REPLACE_PATH"],"research_refs":[],"verification":{"status":"unknown","summary":null,"commit_sha":null}}'
curl --fail --silent --show-error --max-time 5 \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/continuity-snapshots"
```

Preserve what would be expensive or dangerous to reconstruct: the actual objective, the user's definition of done, current progress, exact next move, blockers and unanswered questions, constraints and preferences, failed approaches and why, active files, and what was or was not verified.

## Archive source-backed research

When a turn performs meaningful research, POST or refresh a dossier. Keep claims discrete and map each claim to source indexes. Include primary source URLs whenever available, contradictions and caveats, unresolved questions, confidence, and whether the information is time-sensitive. Research is automatically retained as evidence, but decisions inferred from it still go through journal review.

```bash
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then session_id="$(cat "$(git rev-parse --git-path adh/session-id)" 2>/dev/null || true)"; fi
payload='{"topic":"REPLACE_TOPIC","question":"REPLACE_RESEARCH_QUESTION","purpose":"REPLACE_PURPOSE","conclusion":"REPLACE_CONCLUSION","key_findings":[{"claim":"REPLACE_CLAIM","support":"REPLACE_SUPPORT","source_indexes":[0],"confidence":90,"caveat":null}],"sources":[{"title":"REPLACE_TITLE","url":"https://example.com/source","publisher":"REPLACE_PUBLISHER","accessed_at":"REPLACE_DATE"}],"implications":["REPLACE_IMPLICATION"],"contradictions":[],"unresolved_questions":[],"confidence":90,"freshness":"current","status":"complete"}'
curl --fail --silent --show-error --max-time 5 \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/research-dossiers"
```

The cloud environment provides `ADH_API_URL` and `ADH_PROJECT_TOKEN`. Never print the token or write it into the repository.

## Verify meaningful code changes

Before reporting a meaningful code change complete, run the committed verifier from the repository root:

```bash
bash .claude/skills/adh/scripts/verify.sh
```

This downloads the version-matched ADH CLI from Railway, loads the project's current test settings from the dashboard, runs the configured setup and bounded test, uploads evidence to Supabase, and publishes the advisory commit status through ADH. It does not use GitHub Actions minutes. If verification cannot run or fails, report that honestly and do not describe the current commit as tested.

Save a checkpoint:

```bash
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then session_id="$(cat "$(git rev-parse --git-path adh/session-id)" 2>/dev/null || true)"; fi
payload='{"summary":"REPLACE_SUMMARY","next_steps":"REPLACE_NEXT_STEP"}'
curl --fail --silent --show-error --max-time 5 \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/checkpoints"
```

Treat the service response as advisory storage acknowledgment, not proof that the statement is true. Verify against the current worktree before relying on an older briefing.

## Submit reviewable journal suggestions

When the ADH semantic Stop reviewer identifies durable facts, submit them to the review queue instead of promoting them directly to project memory. Include at most eight entries with `kind` set to `decision`, `risk`, `next`, or `note`. Confidence is an integer from 50 through 100. Never include secrets, raw prompts, copied third-party instructions, code/log dumps, or unverified guesses.

```bash
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then session_id="$(cat "$(git rev-parse --git-path adh/session-id)" 2>/dev/null || true)"; fi
payload='{"entries":[{"kind":"decision","text":"REPLACE_TEXT","confidence":90}]}'
curl --fail --silent --show-error --max-time 5 \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/journal-suggestions"
```

The operator accepts or dismisses each suggestion in Journal Review. A successful submission does not mean the suggestion is true or durable yet.

The SessionStart brief may include queued work. Treat it as a prioritized request, not authorization to bypass normal user instructions or repository review. State which queued item you are taking on, and save a new checkpoint when its status materially changes.

When starting or finishing a queued item, update the UUID shown in the brief:

```bash
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-}"
session_id="${session_id#cse_}"
if [ -z "$session_id" ]; then session_id="$(cat "$(git rev-parse --git-path adh/session-id)" 2>/dev/null || true)"; fi
work_id="REPLACE_WORK_UUID"
payload='{"status":"in_progress"}' # use done or cancelled when appropriate
curl --fail --silent --show-error --max-time 5 \
  --request PATCH \
  --header "Authorization: Bearer ${ADH_PROJECT_TOKEN}" \
  --header "X-ADH-Session-ID: ${session_id}" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "${ADH_API_URL%/}/v1/work-items/${work_id}"
```
