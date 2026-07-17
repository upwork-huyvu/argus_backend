import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

@Injectable()
export class SupabaseService {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly serviceRoleKey: string;
  private readonly bypassRls: boolean;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>("SUPABASE_URL")?.trim();
    const anon = this.config.get<string>("SUPABASE_ANON_KEY")?.trim();
    const serviceRole = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const jwtSecret = this.config.get<string>("JWT_SECRET");
    const disableRlsFlag = this.config.get<string>("SUPABASE_DISABLE_RLS");

    // Report ALL missing vars at once, plus what the process can actually see.
    // Env files are gitignored and never deployed, so on Railway/Vercel these
    // must come from the service's Variables. Names only — never log values.
    if (!url || !anon || !serviceRole) {
      const missing = [
        ["SUPABASE_URL", url],
        ["SUPABASE_ANON_KEY", anon],
        ["SUPABASE_SERVICE_ROLE_KEY", serviceRole],
      ]
        .filter(([, value]) => !value)
        .map(([name]) => name);
      const visible = Object.keys(process.env)
        .filter((k) => k.toUpperCase().includes("SUPABASE"))
        .sort();
      throw new Error(
        `Missing required Supabase env var(s): ${missing.join(", ")}. ` +
          `NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}. ` +
          `SUPABASE-like keys visible to this process: ${
            visible.length > 0 ? visible.join(", ") : "(none)"
          }. ` +
          `Total env keys visible: ${Object.keys(process.env).length}. ` +
          `Set these in your host's Variables (Railway/Vercel) — .env files are ` +
          `gitignored and are never deployed.`,
      );
    }

    this.supabaseUrl = url;
    this.anonKey = anon;
    this.serviceRoleKey = serviceRole;

    // Dev/dev-mvp mode:
    // - If JWT_SECRET is missing/placeholder, Supabase RLS won't accept our JWT.
    // - Bypass RLS using service_role and enforce permissions in backend code instead.
    const disableRls = disableRlsFlag?.trim().toLowerCase() === "true";
    const normalizedJwt = jwtSecret?.trim();
    this.bypassRls = disableRls || !normalizedJwt || normalizedJwt === "argus_secret";
  }

  getAdminClient(): SupabaseClient {
    return createClient(this.supabaseUrl, this.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  getUserClient(accessToken: string): SupabaseClient {
    if (this.bypassRls) {
      return this.getAdminClient();
    }

    // RLS uses `auth.uid()` + `auth.jwt()`. Pass backend-issued JWT so Supabase can evaluate policies.
    return createClient(this.supabaseUrl, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }
}

