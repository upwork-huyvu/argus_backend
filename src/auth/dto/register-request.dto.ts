import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { USER_ROLES, type UserRole } from "../../common/permissions";

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
