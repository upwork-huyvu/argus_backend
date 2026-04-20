import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { SupabaseService } from "../supabase/supabase.service";
import { normalizeRole, type UserRole } from "../permissions";

/**
 * Payload shape for a Supabase-issued access token (HS256).
 * Supabase puts app-specific claims in `app_metadata` / `user_metadata`.
 * Our canonical role lives in the `app_users` table and is loaded per request.
 */
type SupabaseJwtPayload = {
  sub: string;
  aud?: string | string[];
  email?: string;
  role?: string; // "authenticated" — not our app role
  exp?: number;
};

export type AuthUser = {
  userId: string;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  accessToken: string;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const token = authHeader.slice("bearer ".length).trim();
    const secret = this.resolveSupabaseSecret();

    let payload: SupabaseJwtPayload;
    try {
      payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
      }) as unknown as SupabaseJwtPayload;
    } catch {
      throw new UnauthorizedException("Unauthorized.");
    }

    if (!payload?.sub) throw new UnauthorizedException("Unauthorized.");

    // Load app-specific role + active flag from profile table.
    const admin = this.supabase.getAdminClient();
    const { data: profile, error } = await admin
      .from("app_users")
      .select("id,email,role,is_active")
      .eq("id", payload.sub)
      .maybeSingle<{ id: string; email: string | null; role: string; is_active: boolean }>();

    if (error || !profile) {
      throw new UnauthorizedException("Unauthorized.");
    }
    if (!profile.is_active) {
      throw new UnauthorizedException("Account deactivated.");
    }

    req.user = {
      userId: profile.id,
      email: profile.email ?? payload.email ?? null,
      role: normalizeRole(profile.role),
      isActive: profile.is_active,
      accessToken: token,
    };
    return true;
  }

  /**
   * Prefer `SUPABASE_JWT_SECRET` (the secret Supabase uses to sign access tokens).
   * Falls back to legacy `JWT_SECRET` during transition so already-deployed
   * environments don't break until ops updates env files.
   */
  private resolveSupabaseSecret(): string {
    const primary = this.config.get<string>("SUPABASE_JWT_SECRET")?.trim();
    if (primary) return primary;
    const legacy = this.config.get<string>("JWT_SECRET")?.trim();
    if (legacy) return legacy;
    throw new UnauthorizedException("Server auth secret is not configured.");
  }
}
