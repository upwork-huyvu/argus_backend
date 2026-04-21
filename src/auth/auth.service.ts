import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";
import { SupabaseService } from "../common/supabase/supabase.service";
import {
  ROLE_PERMISSIONS,
  normalizeRole,
  type UserRole,
  type UserPermissions,
} from "../common/permissions";
import type { RegisterRequestDto } from "./dto/register-request.dto";

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  username: string | null;
  phone: string | null;
  organization: string | null;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
};

export type AuthUserProfile = {
  id: string;
  email: string;
  fullName: string | null;
  username: string | null;
  phone: string | null;
  organization: string | null;
  avatarUrl: string | null;
  role: UserRole;
  isActive: boolean;
  permissions: UserPermissions;
};

export type AuthSessionResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  user: AuthUserProfile;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Login — accepts either email or username as `identifier`.
  // ---------------------------------------------------------------------------
  async login(identifier: string, password: string): Promise<AuthSessionResponse> {
    const raw = identifier.trim();
    const p = password;
    if (!raw || !p) throw new BadRequestException("Validation failed.");

    // Treat anything containing '@' as an email; otherwise look up
    // app_users.username → email and fall back to that.
    const email = raw.includes("@")
      ? raw.toLowerCase()
      : await this.resolveEmailByUsername(raw.toLowerCase());

    if (!email) {
      // Hide the distinction between "unknown username" and "wrong password"
      // so username enumeration doesn't leak usernames that exist.
      throw new UnauthorizedException("Invalid credentials.");
    }

    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin.auth.signInWithPassword({
      email,
      password: p,
    });

    if (error || !data.session || !data.user) {
      throw new UnauthorizedException("Invalid credentials.");
    }

    const profile = await this.loadProfile(data.user.id);
    if (!profile.is_active) {
      throw new UnauthorizedException("Account deactivated.");
    }

    // Fire-and-forget last_login_at update.
    await admin
      .from("app_users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", data.user.id);

    return this.toSessionResponse(data.session, profile, data.user);
  }

  private async resolveEmailByUsername(username: string): Promise<string | null> {
    const admin = this.supabase.getAdminClient();
    const { data } = await admin
      .from("app_users")
      .select("email")
      .eq("username", username)
      .maybeSingle<{ email: string | null }>();
    return data?.email ?? null;
  }

  // ---------------------------------------------------------------------------
  // Self-register (always GUEST)
  // ---------------------------------------------------------------------------
  async register(body: RegisterRequestDto): Promise<AuthSessionResponse> {
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    const fullName = body.fullName.trim();
    const username = body.username.trim().toLowerCase();
    if (!email || !password || !fullName || !username) {
      throw new BadRequestException("Validation failed.");
    }

    const admin = this.supabase.getAdminClient();

    // Pre-flight username uniqueness check so we can return a clean 409 before
    // creating the auth.users row. The DB unique index is the real guarantee —
    // if there's a race we catch the 23505 below and convert it to a Conflict.
    const { data: existing } = await admin
      .from("app_users")
      .select("id")
      .eq("username", username)
      .maybeSingle<{ id: string }>();
    if (existing) {
      throw new ConflictException("Username already taken.");
    }

    const { data, error } = await admin.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          username,
          phone: body.phone ?? null,
          organization: body.organization ?? null,
          // Self-register path — role is always GUEST regardless of request body.
          // Admin user-creation goes through AdminService.createUser.
          role: "GUEST",
        },
      },
    });

    if (error) {
      // Race condition: unique index on username may fire between the pre-flight
      // check and the trigger's insert. Supabase surfaces this as "Database
      // error saving new user" — normalize to 409.
      if (/username|23505|unique/i.test(error.message)) {
        throw new ConflictException("Username already taken.");
      }
      if (/already.*registered|exists/i.test(error.message)) {
        throw new ConflictException("Email already registered.");
      }
      if (/password/i.test(error.message)) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(error.message || "Unable to register.");
    }

    if (!data.user) {
      throw new InternalServerErrorException("Registration succeeded but no user returned.");
    }

    // The `handle_new_auth_user` trigger inserts the profile row; re-read it so
    // we return a consistent shape. If the trigger hasn't fired yet (rare), fall
    // back to a best-effort upsert.
    let profile = await this.tryLoadProfile(data.user.id);
    if (!profile) {
      await admin.from("app_users").upsert({
        id: data.user.id,
        email,
        full_name: fullName,
        username,
        phone: body.phone ?? null,
        organization: body.organization ?? null,
        role: "GUEST",
        is_active: true,
      });
      profile = await this.loadProfile(data.user.id);
    }

    // When email confirmations are enabled, `data.session` is null — client
    // must log in after verification. Return an "unauthenticated" response in
    // that case so the FE can show the right UI.
    if (!data.session) {
      return {
        accessToken: "",
        refreshToken: "",
        expiresAt: null,
        user: this.normalizeProfile(profile, data.user.email ?? email),
      };
    }

    return this.toSessionResponse(data.session, profile, data.user);
  }

  // ---------------------------------------------------------------------------
  // Forgot password — sends Supabase reset email.
  // ---------------------------------------------------------------------------
  async forgotPassword(email: string): Promise<{ sent: true }> {
    const e = email.trim().toLowerCase();
    if (!e) throw new BadRequestException("Email is required.");

    const redirectTo = this.config.get<string>("PASSWORD_RESET_REDIRECT_URL");
    const admin = this.supabase.getAdminClient();

    const { error } = await admin.auth.resetPasswordForEmail(e, {
      redirectTo: redirectTo?.trim() || undefined,
    });

    // Always report success so the endpoint cannot be used for account enumeration.
    if (error) {
      // eslint-disable-next-line no-console
      console.warn("[auth] resetPasswordForEmail failed:", error.message);
    }
    return { sent: true };
  }

  // ---------------------------------------------------------------------------
  // Change password — requires the caller's access token.
  // ---------------------------------------------------------------------------
  async changePassword(
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    if (!accessToken) throw new UnauthorizedException("Unauthorized.");
    if (!currentPassword || !newPassword) {
      throw new BadRequestException("Validation failed.");
    }
    if (newPassword.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters.");
    }

    const admin = this.supabase.getAdminClient();
    const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
    if (userErr || !userData.user?.email) {
      throw new UnauthorizedException("Unauthorized.");
    }

    // Re-verify current password to prevent silent hijack if the token is stolen.
    const { error: verifyErr } = await admin.auth.signInWithPassword({
      email: userData.user.email,
      password: currentPassword,
    });
    if (verifyErr) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    const { error: updateErr } = await admin.auth.admin.updateUserById(userData.user.id, {
      password: newPassword,
    });
    if (updateErr) {
      throw new BadRequestException(updateErr.message || "Unable to update password.");
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Logout — revoke refresh tokens server-side.
  // ---------------------------------------------------------------------------
  async logout(accessToken: string): Promise<{ ok: true }> {
    if (!accessToken) return { ok: true };
    const admin = this.supabase.getAdminClient();
    const { data: userData } = await admin.auth.getUser(accessToken);
    if (userData?.user?.id) {
      // signOut by user id invalidates their refresh tokens across devices.
      await admin.auth.admin.signOut(userData.user.id, "global");
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Refresh Supabase session with a refresh_token.
  // ---------------------------------------------------------------------------
  async refresh(refreshToken: string): Promise<AuthSessionResponse> {
    if (!refreshToken) throw new BadRequestException("refreshToken is required.");
    const anon = this.supabase.getAdminClient();
    const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session || !data.user) {
      throw new UnauthorizedException("Session expired.");
    }

    const profile = await this.loadProfile(data.user.id);
    return this.toSessionResponse(data.session, profile, data.user);
  }

  // ---------------------------------------------------------------------------
  // Current user
  // ---------------------------------------------------------------------------
  async getMe(userId: string): Promise<AuthUserProfile> {
    const profile = await this.loadProfile(userId);
    return this.normalizeProfile(profile, profile.email ?? "");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private async tryLoadProfile(userId: string): Promise<ProfileRow | null> {
    const admin = this.supabase.getAdminClient();
    const { data } = await admin
      .from("app_users")
      .select(
        "id,email,full_name,username,phone,organization,avatar_url,role,is_active,last_login_at",
      )
      .eq("id", userId)
      .maybeSingle<ProfileRow>();
    return data ?? null;
  }

  private async loadProfile(userId: string): Promise<ProfileRow> {
    const row = await this.tryLoadProfile(userId);
    if (!row) throw new UnauthorizedException("Profile not found.");
    return row;
  }

  private normalizeProfile(row: ProfileRow, fallbackEmail: string): AuthUserProfile {
    const role = normalizeRole(row.role);
    return {
      id: row.id,
      email: row.email ?? fallbackEmail,
      fullName: row.full_name,
      username: row.username,
      phone: row.phone,
      organization: row.organization,
      avatarUrl: row.avatar_url,
      role,
      isActive: row.is_active,
      permissions: ROLE_PERMISSIONS[role],
    };
  }

  private toSessionResponse(
    session: Session,
    profile: ProfileRow,
    user: SupabaseUser,
  ): AuthSessionResponse {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ?? null,
      user: this.normalizeProfile(profile, user.email ?? ""),
    };
  }
}
