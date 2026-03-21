import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ROLE_PERMISSIONS, type UserRole, type UserPermissions } from "../common/permissions";
import bcrypt from "bcryptjs";
import type { RegisterRequestDto } from "./dto/register-request.dto";

type AppUserRow = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  password_hash: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: string, password: string) {
    const u = username.trim().toLowerCase();
    const p = password.trim();

    if (!u || !p) throw new BadRequestException({ message: "Validation failed." });

    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .select("id,name,username,role,password_hash")
      .eq("username", u)
      .maybeSingle<AppUserRow>();

    if (error || !data) {
      throw new UnauthorizedException("Invalid credentials.");
    }

    const ok = await bcrypt.compare(p, data.password_hash);
    if (!ok) throw new UnauthorizedException("Invalid credentials.");

    const token = this.jwtService.sign(
      { role: data.role },
      { subject: data.id },
    );

    const permissions: UserPermissions = ROLE_PERMISSIONS[data.role];

    return {
      accessToken: token,
      user: {
        name: data.name,
        username: data.username,
        role: data.role,
        permissions,
      },
    };
  }

  async register(body: RegisterRequestDto) {
    const name = body.name.trim();
    const username = body.username.trim().toLowerCase();
    const password = body.password.trim();
    const role: UserRole = body.role ?? "viewer";

    if (!name || !username || !password) throw new BadRequestException({ message: "Validation failed." });

    const admin = this.supabase.getAdminClient();

    const { data: existing } = await admin
      .from("app_users")
      .select("id")
      .eq("username", username)
      .maybeSingle<{ id: string }>();

    if (existing) throw new BadRequestException({ message: "Username already exists." });

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await admin
      .from("app_users")
      .insert({
        name,
        username,
        role,
        password_hash,
      })
      .select("id,name,username,role,password_hash")
      .maybeSingle<AppUserRow>();

    if (error || !data) {
      throw new BadRequestException({ message: "Unable to register." });
    }

    const token = this.jwtService.sign(
      { role: data.role },
      { subject: data.id },
    );

    const permissions: UserPermissions = ROLE_PERMISSIONS[data.role];

    return {
      accessToken: token,
      user: {
        name: data.name,
        username: data.username,
        role: data.role,
        permissions,
      },
    };
  }
}

