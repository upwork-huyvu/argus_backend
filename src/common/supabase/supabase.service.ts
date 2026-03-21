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
    const url = this.config.get<string>("SUPABASE_URL");
    const anon = this.config.get<string>("SUPABASE_ANON_KEY");
    const serviceRole = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    const jwtSecret = this.config.get<string>("JWT_SECRET");
    const disableRlsFlag = this.config.get<string>("SUPABASE_DISABLE_RLS");

    if (!url) throw new Error("Missing SUPABASE_URL");
    if (!anon) throw new Error("Missing SUPABASE_ANON_KEY");
    if (!serviceRole) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

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

