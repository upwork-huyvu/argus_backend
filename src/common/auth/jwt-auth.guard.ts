import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { SupabaseService } from "../supabase/supabase.service";
import { normalizeRole, type UserRole } from "../permissions";

/**
 * Supabase access-token claims shape. The library emits any extra keys as
 * unknown — we only read `sub` / `email` / `exp` directly.
 */
type SupabaseJwtPayload = JWTPayload & {
  sub?: string;
  email?: string;
  role?: string; // "authenticated" — not our app role
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
  /**
   * Lazy JWKS fetcher. Supabase rotates signing keys periodically; jose caches
   * internally (default 10 min) and re-fetches on kid miss, so we can safely
   * build this once at boot.
   */
  private jwks: JWTVerifyGetKey | null = null;

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

    let payload: SupabaseJwtPayload;
    try {
      const key = this.getJwks();
      const { payload: verified } = await jwtVerify(token, key, {
        // Supabase currently ships ES256 on new projects but older projects
        // still use HS256. Accept every algorithm Supabase supports so the
        // guard works across project ages without code changes.
        algorithms: ["ES256", "RS256", "HS256"],
      });
      payload = verified as SupabaseJwtPayload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn("[JwtAuthGuard] verify failed:", msg);
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
      // eslint-disable-next-line no-console
      console.warn(
        "[JwtAuthGuard] profile lookup failed for sub=",
        payload.sub,
        "err=",
        error?.message,
      );
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
   * Returns a key resolver `jose` can use for both symmetric and asymmetric
   * Supabase tokens:
   *  - Asymmetric (ES256/RS256) → fetched from /auth/v1/.well-known/jwks.json
   *  - Symmetric (HS256) → falls back to SUPABASE_JWT_SECRET / JWT_SECRET
   *
   * `createRemoteJWKSet` transparently handles "alg: HS256 + kid missing" by
   * throwing — in that case we re-verify in the catch branch with the shared
   * secret. Implemented via a custom resolver below.
   */
  private getJwks(): JWTVerifyGetKey {
    if (this.jwks) return this.jwks;

    const supabaseUrl = this.config.get<string>("SUPABASE_URL")?.trim();
    if (!supabaseUrl) {
      throw new UnauthorizedException("Server auth is not configured (SUPABASE_URL missing).");
    }

    const remoteJwks = createRemoteJWKSet(
      new URL(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`),
    );

    // Shared-secret fallback used when the token's alg is HS256 (legacy
    // projects). jose's remote JWKS can't provide symmetric keys.
    const hs256Secret = this.resolveHs256Secret();

    this.jwks = async (protectedHeader, flattenedJws) => {
      if (protectedHeader.alg === "HS256") {
        if (!hs256Secret) {
          throw new Error("HS256 token but no shared secret configured");
        }
        return new TextEncoder().encode(hs256Secret);
      }
      return remoteJwks(protectedHeader, flattenedJws);
    };

    return this.jwks;
  }

  /**
   * HS256 fallback. Prefer `SUPABASE_JWT_SECRET`; accept legacy `JWT_SECRET`
   * only when it's clearly non-default (>= 32 chars). `argus_secret` is the
   * historical placeholder — ignore it so a misconfigured dev env doesn't
   * masquerade as "real" auth.
   */
  private resolveHs256Secret(): string | null {
    const primary = this.config.get<string>("SUPABASE_JWT_SECRET")?.trim();
    if (primary && primary !== "argus_secret") return primary;
    const legacy = this.config.get<string>("JWT_SECRET")?.trim();
    if (legacy && legacy !== "argus_secret" && legacy.length >= 32) return legacy;
    return null;
  }
}
