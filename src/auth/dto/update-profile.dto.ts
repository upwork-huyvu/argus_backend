import { IsOptional, IsString, IsUrl, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Profile fields the user can edit themselves. Role / isActive / email are
 * NOT here on purpose — those flow through the admin API so self-service
 * can't escalate privileges or break login.
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

  @ApiPropertyOptional({ example: "https://cdn.argus.io/avatars/jane.png" })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  avatarUrl?: string;
}
