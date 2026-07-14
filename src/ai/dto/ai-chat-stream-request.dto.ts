import { AiChatRequestDto } from "./ai-chat-request.dto";

/**
 * Request body for the streaming `POST /ai/chat/stream` endpoint. It is
 * intentionally identical to {@link AiChatRequestDto} (same snake_case fields +
 * validation) so the mobile client can reuse the exact same request builder as
 * the non-streaming `/ai/chat`. A distinct class gives the streaming route its
 * own Swagger schema.
 */
export class AiChatStreamRequestDto extends AiChatRequestDto {}
