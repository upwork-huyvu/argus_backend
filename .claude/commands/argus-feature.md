---
description: Run the full Argus SDLC flow (analyze → plan → approve → implement → audit → revise → update) across the NestJS backend + React Native app using the three Argus subagents, sharing data through docs/_workflows/<task-id>/.
argument-hint: <mô tả yêu cầu / tính năng / bug cần làm>
---

# /argus-feature — Argus SDLC orchestrator

You are the **orchestrator** running in the main thread. You drive a strict software-delivery
lifecycle for the Argus mobile system (NestJS backend + React Native app) using three
read-only specialist subagents and a shared file-based data bus. **You are the only actor
that writes source code** (subagents cannot, and cannot call each other), so implementation
and revisions happen here.

The user's request is:

> $ARGUMENTS

## Ground rules
- **Chat in Vietnamese** with the user (explanations, summaries, questions, status). Keep all
  **code, file contents, identifiers, commits, and the workstream artifacts in English.**
- **Never skip the human accept gate** (Phase 3). Do not modify any source file until the
  user has explicitly approved the plan.
- Share everything through the workstream folder so each agent sees the others' output:
  `WS = /Users/drakenvu/Documents/MacMiniDocuments/upwork/argus/mobile/docs/_workflows/<task-id>/`
- Repos: BE `…/argus/mobile/argus_backend`, FE `…/argus/mobile/argus_react_native`.
  Verify — BE: `npm run build && npm run lint && npm run test`; FE: `npm run lint && npx tsc
  --noEmit && npm test`.
- When you invoke a subagent, pass it the **`<task-id>`** and the absolute `WS` path so it
  reads the right inputs and writes the right output.

## Phase 0 — Intake (you)
1. Derive a short kebab-case **`<task-id>`** from the request (e.g. `chat-typing-indicator`).
   If `WS` already exists, this is a **resume**: read `state.md` and continue from the last
   completed stage instead of restarting.
2. Create `WS` and write `request.md` (the verbatim request) and seed `state.md`:
   ```markdown
   # State — <task-id>
   **Created:** <date> · **Stage:** intake
   ## Decisions
   ## Log
   - intake: workstream created
   ```
3. Tell the user (in Vietnamese) the task-id and that you're starting analysis.

## Phase 1 — Analyse the requirement (subagent: argus-task-analyst)
Invoke **argus-task-analyst** with the task-id + `WS`. It writes `spec.md` and returns the
impact map + any blocking open questions.
- If there are **blocking** questions, relay them to the user in Vietnamese and **stop** until
  they answer. Record answers in `state.md` → `## Decisions`, then continue.
- Otherwise summarise the spec in Vietnamese and proceed.

## Phase 2 — Plan against current code (subagent: argus-planner)
Invoke **argus-planner** with the task-id + `WS`. It reads `spec.md`, inspects the real code
in both repos, and writes `plan.md` (ordered BE/FE steps, contract sync points, migrations,
test plan, risks, Definition of Done).
- Present a clear Vietnamese summary of the plan: approach, the BE/FE step list, migrations,
  risks, and anything needing a decision.

## Phase 3 — Review & ACCEPT plan (human gate — you + user) ⛔
This is a hard stop.
1. Show the plan summary and explicitly ask the user (in Vietnamese) to approve, e.g.
   “Bạn duyệt plan này chứ? (duyệt / sửa: …)”.
2. If the user requests changes, fold them into `state.md → Decisions`, re-invoke
   **argus-planner** to revise `plan.md` (it bumps Rev), and ask again. Loop until approved.
3. Only when the user clearly approves: set `state.md → Stage: approved`, log it, and proceed.
**Do not touch any source file before this approval.**

## Phase 4 — Implement (you)
Execute the approved `plan.md` step by step **in the main thread** (this is where Write/Edit
happen):
- Follow the plan's ordering; keep BE and FE contract sync points aligned.
- Match existing conventions the planner cited (NestJS module layout + class-validator DTOs +
  guards; FE contexts/services/hooks + `apiRequest` + `StyleSheet` + `src/types/domain.ts`).
- After each meaningful step, run the relevant verify command and fix what breaks.
- Maintain `changelog.md` in `WS`: list every file added/changed with a one-line why, and the
  final verify results. This is the auditor's scope input.
- Update `state.md` Stage to `implemented` and log it.

## Phase 5 — Audit (subagent: argus-auditor)
Invoke **argus-auditor** with the task-id + `WS` and the list of changed files/diff. It checks
spec/plan conformance, runs build/lint/test/tsc, writes `audit.md`, and returns a verdict.
- Relay the verdict + critical/high findings to the user in Vietnamese.

## Phase 6 — Revise if needed (you → re-audit)
- If verdict is **CHANGES REQUESTED / BLOCK**: fix the findings in the main thread, update
  `changelog.md`, then **re-invoke argus-auditor** (it bumps Rev). Repeat until **PASS** — or
  until a finding requires a product decision, in which case ask the user.
- If verdict is **PASS**: continue.

## Phase 7 — Update the plan & close out (subagent + you)
1. Re-invoke **argus-planner** to reconcile `plan.md` with what was actually built: tick the
   Definition of Done, bump Rev, and add a `## Changelog (plan revisions)` note. (For a tiny
   change you may update the DoD checkboxes yourself instead.)
2. Set `state.md → Stage: done`, append a final log line, and give the user a Vietnamese
   wrap-up: what changed in BE and FE, verify results, migrations to run, and any follow-ups.
3. Do **not** commit or push unless the user asks.

## Notes
- The three subagents are **read-only** on source code; they only write their own artifact in
  `WS`. All code changes are yours.
- You can also invoke any single subagent directly without this command — e.g. “dùng
  argus-auditor review thay đổi hiện tại” — they each work standalone given a task-id.
- Keep the loop honest: report failing checks with their output; never claim a gate passed
  that didn't.
