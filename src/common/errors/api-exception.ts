import { HttpException } from "@nestjs/common";

/**
 * HttpException that carries a stable machine-readable `code` alongside the
 * human message. `HttpExceptionFilter` surfaces `code` in the JSON response so
 * ESP32 firmware / the app can branch on it (e.g. `INVALID_MAC`,
 * `DEVICE_DISABLED`). See docs/ESP32_DEVICE_MVP_PLAN.md §7.5.
 */
export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ message, code }, status);
  }
}
