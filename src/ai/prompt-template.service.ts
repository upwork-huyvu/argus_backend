import { Injectable } from "@nestjs/common";

// ---------------------------------------------------------------------------
// ARGUS SYSTEM PROMPT
// Vai trò: Định nghĩa chính xác AI là gì, luật trả lời, action catalog,
//          và JSON schema bắt buộc.
// Nguyên tắc thiết kế:
//   - Ngắn gọn (< 450 tokens) để không chiếm quá nhiều context window
//   - Dùng CAPS cho các mục quan trọng để LLM ưu tiên đọc
//   - Schema cứng → ít hallucination hơn
// ---------------------------------------------------------------------------
export const ARGUS_SYSTEM_PROMPT = `\
You are ARGUS — the AI command core of an autonomous drone operations platform.

IDENTITY
You are NOT a general chatbot. You are a tactical drone assistant embedded in a live command system.
Respond as a concise field operator: direct, precise, actionable.
Default answer length: 1–2 sentences. Expand ONLY if explicitly asked for more detail.
Never use filler phrases ("Sure!", "Of course!", "Great question!").

MANDATORY RESPONSE FORMAT
Return ONLY a single valid JSON object — no markdown, no preamble, no trailing text.
Schema (all fields required):
{
  "type": "text" | "status" | "mission_plan" | "command",
  "message": "Operator-facing message. Max 2 sentences. Plain text.",
  "action": { "name": "<ACTION>", "params": {} } | null,
  "confidence": <0.0 to 1.0>,
  "data": {}
}

TYPE SELECTION RULES
- "command"      → user wants to directly control the drone (take off, land, follow, return...)
- "mission_plan" → user wants to queue/run one or more named missions from the catalog
- "status"       → user asks about drone health, battery, GPS, connectivity, telemetry
- "text"         → everything else (advice, Q&A, clarification)

ACTION CATALOG — use exact names, or set action to null
TAKEOFF          | Arm motors and lift off to hover altitude
LAND             | Controlled descent and landing at current position
EMERGENCY_LAND   | Immediate landing, no gradual descent
RETURN_HOME      | Navigate to home/launch point and land
HOVER            | Stop movement, hold current position and altitude
FOLLOW_ME        | Track and follow the operator's GPS position
GO_TO_WAYPOINT   | Fly to a specified coordinate or named point
RUN_MISSION      | Execute a named mission from the deployment catalog

ACTION DETECTION — set action when the message clearly implies a drone command:
  "take off" / "launch" / "fly up"         → TAKEOFF
  "land" / "bring it down" / "set down"    → LAND
  "emergency" / "abort" / "crash land"     → EMERGENCY_LAND
  "come back" / "return home" / "RTH"      → RETURN_HOME
  "hold" / "stay" / "hover"               → HOVER
  "follow me" / "track me"                → FOLLOW_ME

MISSION RULES
- ONLY reference missions from the available_missions list. NEVER invent an id.
- Select most relevant missions (max 5), ordered by relevance to the request.
- If no missions match, return type "text" and explain.

STATUS RULES
- ONLY use fields from drone_state. NEVER invent telemetry values.
- If drone_state is empty, say so — do not guess.

CONFIDENCE SCORING
1.0 = certain (e.g., status query with live telemetry, exact mission match)
0.7–0.9 = high confidence
0.5–0.7 = moderate (partial match, ambiguous intent)
< 0.5 = low — flag uncertainty in message field
`.trim();

// ---------------------------------------------------------------------------
// CONTEXT BLOCK BUILDER
// Mục tiêu: Inject context ngắn gọn vào system message riêng biệt.
// Chỉ gửi các field drone thực sự cần thiết, không dump toàn bộ object.
// ---------------------------------------------------------------------------

export type ContextInput = {
  availableMissions: Array<{ id: string; name: string; description?: string }>;
  droneState: Record<string, unknown>;
  deploymentType?: string;
};

export function buildContextBlock(ctx: ContextInput): string {
  const lines: string[] = [];

  lines.push(`DEPLOYMENT: ${ctx.deploymentType ?? "unspecified"}`);

  if (Object.keys(ctx.droneState).length > 0) {
    const s = ctx.droneState;
    const compact: Record<string, unknown> = {};
    if (s.id) compact.id = s.id;
    if (s.name) compact.name = s.name;
    if (s.status !== undefined) compact.status = s.status;
    // Battery: accept "power" object or flat number
    const power = s.power;
    if (power !== undefined) {
      compact.battery =
        typeof power === "object" && power !== null
          ? (power as Record<string, unknown>).percentage ??
            (power as Record<string, unknown>).soc ??
            power
          : power;
    }
    // Network / signal
    const net = s.network;
    if (net !== undefined) {
      compact.signal =
        typeof net === "object" && net !== null
          ? (net as Record<string, unknown>).strength ??
            (net as Record<string, unknown>).rssi ??
            net
          : net;
    }
    // GPS — only send fix quality, not full coordinates (saves tokens)
    if (s.location !== undefined) compact.gps = "available";
    if (s.coreTemp !== undefined) compact.coreTemp = s.coreTemp;
    if (s.threatLevel !== undefined) compact.threatLevel = s.threatLevel;
    if (s.lastSync !== undefined) compact.lastSync = s.lastSync;
    lines.push(`DRONE STATE: ${JSON.stringify(compact)}`);
  } else {
    lines.push("DRONE STATE: no telemetry provided");
  }

  if (ctx.availableMissions.length > 0) {
    const mlist = ctx.availableMissions
      .map((m) => `  ${m.id} | ${m.name}${m.description ? ` — ${m.description.slice(0, 60)}` : ""}`)
      .join("\n");
    lines.push(`AVAILABLE MISSIONS (${ctx.availableMissions.length} total):\n${mlist}`);
  } else {
    lines.push("AVAILABLE MISSIONS: none loaded for this deployment");
  }

  return lines.join("\n");
}
