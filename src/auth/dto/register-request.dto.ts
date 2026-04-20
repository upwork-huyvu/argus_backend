import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { USER_ROLES, type UserRole } from "../../common/permissions";

/** Username format: lowercase alphanumerics + underscore, 3–30 chars. */
export const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

export class RegisterRequestDto {
  @ApiProperty({
    example: "operator@argus.io",
    description: "Email address; will receive Supabase verification/reset mails.",
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: "P@ssw0rd1!",
    description: "Plain-text password (Supabase stores the hash).",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiProperty({
    example: "Jane Doe",
    description: "Display name shown in the app.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @ApiProperty({
    example: "jane_doe",
    description:
      "Unique handle (lowercased on the backend). 3–30 chars, a–z / 0–9 / underscore.",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(USERNAME_REGEX, {
    message: "username must be 3–30 chars: lowercase letters, digits, or _",
  })
  username: string;

  @ApiPropertyOptional({
    example: "+1-407-555-0101",
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({
    example: "Argus Security Inc.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  organization?: string;

  @ApiPropertyOptional({
    example: "GUEST",
    description:
      "Role to assign. Only ADMIN callers may set this; anonymous self-registration always becomes GUEST.",
    enum: USER_ROLES,
  })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;
}
