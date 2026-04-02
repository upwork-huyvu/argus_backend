# AI Chatbox Implementation Progress

## Goal
Implement production-ready AI chatbox flow for DJI drone management with strict JSON response format:

```json
{
  "type": "text | status | mission_plan",
  "message": "string",
  "data": {
    "status": {},
    "missions": []
  }
}
```

## Progress Log

### [Done] 1) Backend AI module scaffolded
- Added `src/ai/ai.module.ts`
- Added `src/ai/ai.controller.ts` with endpoint `POST /ai/chat`
- Added `src/ai/ai.service.ts` with:
  - intent detection (`text | status | mission_plan`)
  - deterministic mission mapping
  - status response generation from `drone_state`
  - strict response canonicalization
  - optional LLM fallback (OpenAI) via `OPENAI_API_KEY`

### [Done] 2) Backend request DTO + validation
- Added `src/ai/dto/ai-chat-request.dto.ts`
- Supports:
  - `user_message`
  - `project_id` (optional)
  - `drone_id` (optional)
  - `deployment_id` (optional)
  - `available_missions` (optional)
  - `drone_state` (optional)

### [Done] 3) Multi-drone support
- Extended `src/arks/arks.service.ts` with `getArkById(...)`
- Exported `ArksService` from `src/arks/arks.module.ts`
- AI service can resolve `drone_state` from `drone_id` if client does not send telemetry object.

### [Done] 4) App wiring
- Registered AI module in `src/app.module.ts`

### [Done] 5) Frontend integration (ArgusRN)
- Added `src/services/ai-service.ts` for API call to `/ai/chat`
- Updated `src/screens/ArgusAIScreen.tsx`:
  - removed local fake bot response logic
  - sends user input to backend AI endpoint
  - renders:
    - `type: "status"` as key-value status card
    - `type: "mission_plan"` as ordered mission list
    - `type: "text"` as normal chat text

## Remaining
- (Done) Backend build passed (`npm run build` in `ArgusBE`).
- (Done) RN type-check passed (`npx tsc --noEmit` in `ArgusRN`).
- (Note) RN global lint has many pre-existing repo-wide style issues unrelated to this feature.
- (Optional next) Add telemetry source in RN (`drone_state`) by selected drone to improve status answers.
- (Optional next) Add execution action button for mission plan output.

## Validation Notes
- Verified new/edited files with IDE lints: no new diagnostics in:
  - `ArgusBE/src/ai/*`
  - `ArgusBE/src/arks/*`
  - `ArgusBE/src/app.module.ts`
  - `ArgusRN/src/services/ai-service.ts`
  - `ArgusRN/src/screens/ArgusAIScreen.tsx`

## Additional Work (Round 2)

### [Done] 6) Real `drone_state` wiring from selected drone
- Updated `ArgusRN/src/screens/ArgusAIScreen.tsx` to read selected drone from `ArkContext`.
- AI request now sends:
  - `drone_id`
  - concrete `drone_state` fields (`power`, `status`, `network`, `location`, etc.)

### [Done] 7) Execute mission plan action in chat UI
- Added `Execute Plan` button under `mission_plan` responses.
- On click, app toggles only disabled missions in sequence using existing mission APIs.
- Added success/error feedback messages into chat thread.

### [Done] 8) Backend metrics logging for observability
- Updated `ArgusBE/src/ai/ai.controller.ts` to log structured event per request:
  - `latencyMs`
  - `responseType`
  - `missionCount`
  - `statusKeys`
  - `deploymentId` / `droneId`

### [Done] 9) Environment variables added
- Updated `ArgusBE/.env.development` with AI runtime envs:
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL` (default `gpt-4.1-mini`)
- Note: RN does not require new AI env keys; it already uses `API_BASE_URL` to call backend `/ai/chat`.

### [Done] 10) Redis memory wired
- Added Redis dependency in backend (`redis` package).
- Added `RedisService` + `RedisModule`:
  - `src/common/redis/redis.service.ts`
  - `src/common/redis/redis.module.ts`
- Added AI memory service:
  - `src/ai/ai-memory.service.ts`
- `AiService` now stores/reuses short-term session memory by user + deployment + drone.
- Added Redis envs:
  - `REDIS_URL`
  - `AI_MEMORY_TTL_SECONDS`

### [Done] 11) Prompt + mission source refactor
- Prompt moved out of service code into `prompts/ai-chat.runtime.prompt.txt`.
- Added `src/ai/prompt-template.service.ts` to load and render prompt template.
- `AiService` now loads mission catalog for prompt from Supabase deployment `construction` (server-side source of truth).

### [Done] 12) Technical documentation
- Added backend doc: `_doc/ai-chat-feature-flow.md`
- Includes:
  - end-to-end flow steps
  - Mermaid activity diagram
  - key files and env variables
