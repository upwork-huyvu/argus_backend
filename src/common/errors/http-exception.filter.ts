import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response, Request } from "express";

function extractMessage(responsePayload: unknown): string | undefined {
  if (!responsePayload) return undefined;
  if (typeof responsePayload === "string") return responsePayload;
  if (typeof responsePayload === "object") {
    const obj = responsePayload as Record<string, unknown>;
    const maybeMessage = obj.message;
    if (typeof maybeMessage === "string") return maybeMessage;
    if (Array.isArray(maybeMessage) && typeof maybeMessage[0] === "string") return maybeMessage[0];
  }
  return undefined;
}

/** Machine-readable error code, when the thrown exception carries one (ApiException). */
function extractCode(responsePayload: unknown): string | undefined {
  if (responsePayload && typeof responsePayload === "object") {
    const code = (responsePayload as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? extractMessage(exception.getResponse()) ?? exception.message
        : (exception as any)?.message ?? "Internal server error";

    const code =
      exception instanceof HttpException ? extractCode(exception.getResponse()) : undefined;

    // Keep response shape consistent for RN. `code` is only present when the
    // thrown exception carried one (ApiException) — optional by design.
    res.status(status).json(code ? { message, code } : { message });
  }
}

