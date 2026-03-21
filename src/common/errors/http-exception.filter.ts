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

    // Keep response shape consistent for RN.
    res.status(status).json({ message });
  }
}

