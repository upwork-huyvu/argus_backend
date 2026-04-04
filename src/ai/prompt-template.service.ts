import { Injectable, Logger } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import path from "node:path";

type PromptArgs = {
  userMessage: string;
  availableMissions: Array<{ id: string; name: string; description?: string }>;
  droneState: Record<string, unknown>;
  chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>;
};

const FALLBACK_PROMPT_TEMPLATE = `You are a friendly teammate who knows drone ops (Argus). Talk like a person.

Return one JSON object only. Keys: "type", "message", "data".

"type" must be exactly "text", "status", or "mission_plan" (pick one).

CRITICAL: If type is "text", "message" must be your full reply — never empty.

Example: {"type":"text","message":"Hey, what's up?","data":{}}

Rules:
1) Missions in data.missions only from available_missions.
2) Status keys in data.status only from drone_state.
3) Use chat_history when it helps.
4) mission_plan only when they want a mission sequence from the catalog.

Input:
user_message={{user_message}}
available_missions={{available_missions}}
drone_state={{drone_state}}
chat_history={{chat_history}}
`;

@Injectable()
export class PromptTemplateService {
  private readonly logger = new Logger(PromptTemplateService.name);
  private cachedTemplate: string | null = null;

  async render(args: PromptArgs): Promise<string> {
    const template = await this.loadTemplate();
    return template
      .replace("{{user_message}}", JSON.stringify(args.userMessage))
      .replace("{{available_missions}}", JSON.stringify(args.availableMissions))
      .replace("{{drone_state}}", JSON.stringify(args.droneState))
      .replace("{{chat_history}}", JSON.stringify(args.chatHistory));
  }

  private async loadTemplate(): Promise<string> {
    if (this.cachedTemplate) return this.cachedTemplate;
    const promptPath = path.resolve(process.cwd(), "prompts", "ai-chat.runtime.prompt.txt");
    try {
      const raw = await readFile(promptPath, "utf8");
      this.cachedTemplate = raw.trim();
      return this.cachedTemplate;
    } catch {
      this.logger.warn(`Prompt file not found at ${promptPath}. Using fallback template.`);
      this.cachedTemplate = FALLBACK_PROMPT_TEMPLATE.trim();
      return this.cachedTemplate;
    }
  }
}
