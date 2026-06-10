import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Profile fields the user can edit themselves. Role / isActive / email are
 * NOT here on purpose — those flow through the admin API so self-service
 * can't escalate privileges or break login.
 *
 * NOTE on avatarUrl: clients should NOT send arbitrary URLs. The expected
 * flow is `POST /auth/me/avatar` (multipart upload) which produces a
 * Supabase Storage public URL and persists it. This field stays here only to
 * support clearing the avatar (empty string → null) and as a defensive layer
 * for direct API callers; AuthService re-validates the host.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: "Jane Doe", maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ example: "+1-407-555-0101", maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: "Argus Security Inc.", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  organization?: string;

  /**
   * Avatar URL.
   * - Empty string → clear (BE persists `null`).
   * - Otherwise must be https://. AuthService also enforces the Supabase
   *   project host as a runtime whitelist so callers can't store
   *   `file://`, `content://`, `http://attacker/...`, or relative paths.
   */
  @ApiPropertyOptional({
    example: "https://<project>.supabase.co/storage/v1/object/public/avatars/<uid>/<ts>.png",
    maxLength: 2048,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  // Empty string is allowed (clears the avatar). Otherwise reject anything
  // that isn't a plain https URL — blocks file:, content:, android.resource:,
  // data:, http:, javascript:, and bare paths.
  @ValidateIf((o: UpdateProfileDto) => typeof o.avatarUrl === "string" && o.avatarUrl.length > 0)
  @Matches(/^https:\/\/[^\s<>"']+$/, {
    message: "avatarUrl must be an https:// URL.",
  })
  avatarUrl?: string;
}
