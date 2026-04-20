import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import {
  ROLE_PERMISSIONS,
  normalizeRole,
  type UserRole,
  type UserPermissions,
} from "../common/permissions";

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  organization: string | null;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type AdminUserListItem = {
  id: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  organization: string | null;
  avatarUrl: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  permissions: UserPermissions;
};

type CreateUserArgs = {
  email: string;
  password: string;
  fullName: string;
  phone?: string | null;
  organization?: string | null;
  role?: UserRole;
  createdBy: string;
};

@Injectable()
export class AdminService {
  constructor(private readonly supabase: SupabaseService) {}

  async listUsers(): Promise<AdminUserListItem[]> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .select(
        "id,email,full_name,phone,organization,avatar_url,role,is_active,last_login_at,created_at,updated_at",
      )
      .order("created_at", { ascending: false })
      .returns<ProfileRow[]>();

    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((row) => this.normalize(row));
  }

  async updateRole(userId: string, role: UserRole): Promise<AdminUserListItem> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .update({ role })
      .eq("id", userId)
      .select(
        "id,email,full_name,phone,organization,avatar_url,role,is_active,last_login_at,created_at,updated_at",
      )
      .maybeSingle<ProfileRow>();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException("User not found.");
    return this.normalize(data);
  }

  async setActive(userId: string, isActive: boolean): Promise<AdminUserListItem> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .update({ is_active: isActive })
      .eq("id", userId)
      .select(
        "id,email,full_name,phone,organization,avatar_url,role,is_active,last_login_at,created_at,updated_at",
      )
      .maybeSingle<ProfileRow>();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException("User not found.");

    // Revoke active Supabase sessions when deactivating so the user is kicked out
    // immediately instead of waiting for their access_token to expire.
    if (!isActive) {
      await admin.auth.admin.signOut(userId, "global").catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[admin] signOut after deactivate failed:", err?.message ?? err);
      });
    }

    return this.normalize(data);
  }

  async createUser(args: CreateUserArgs): Promise<AdminUserListItem> {
    const email = args.email.trim().toLowerCase();
    const role = args.role ?? "GUEST";
    if (!email || !args.password || !args.fullName) {
      throw new BadRequestException("Validation failed.");
    }

    const admin = this.supabase.getAdminClient();

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: args.password,
      email_confirm: true, // admin-created accounts skip the confirmation email
      user_metadata: {
        full_name: args.fullName.trim(),
        phone: args.phone ?? null,
        organization: args.organization ?? null,
        role,
      },
    });

    if (error) {
      if (/already.*registered|exists/i.test(error.message)) {
        throw new ConflictException("Email already registered.");
      }
      throw new BadRequestException(error.message);
    }
    if (!data.user) throw new BadRequestException("Unable to create user.");

    // Trigger inserts the profile row. Patch created_by + final role explicitly
    // so the admin's id is recorded and role mismatches don't slip through.
    const { data: profile, error: patchErr } = await admin
      .from("app_users")
      .update({ role, created_by: args.createdBy })
      .eq("id", data.user.id)
      .select(
        "id,email,full_name,phone,organization,avatar_url,role,is_active,last_login_at,created_at,updated_at",
      )
      .maybeSingle<ProfileRow>();

    if (patchErr || !profile) {
      throw new BadRequestException(patchErr?.message ?? "Unable to finalize user.");
    }
    return this.normalize(profile);
  }

  private normalize(row: ProfileRow): AdminUserListItem {
    const role = normalizeRole(row.role);
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone,
      organization: row.organization,
      avatarUrl: row.avatar_url,
      role,
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      permissions: ROLE_PERMISSIONS[role],
    };
  }
}
