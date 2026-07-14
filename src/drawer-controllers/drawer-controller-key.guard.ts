import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { ApiException } from "../common/errors/api-exception";

/**
 * MVP device auth: a single shared key sent as `X-Controller-Key`.
 * See docs/ESP32_DEVICE_MVP_PLAN.md §7.1, §18 (move to per-controller keys
 * before pilot). Uses a constant-time-ish compare to avoid trivial leaks.
 */
@Injectable()
export class DrawerControllerKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers["x-controller-key"];
    const expected = this.config.get<string>("CONTROLLER_API_KEY")?.trim();

    if (!expected) {
      // Fail closed: a missing server key must not accept every device.
      throw new ApiException(401, "INVALID_CONTROLLER_KEY", "Controller key not configured.");
    }
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!value || !timingSafeEqual(value, expected)) {
      throw new ApiException(401, "INVALID_CONTROLLER_KEY", "Invalid controller key.");
    }
    return true;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
