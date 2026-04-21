import { IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginRequestDto {
  @ApiProperty({
    example: "admin",
    description:
      "Email or username. Values containing '@' are treated as email; otherwise looked up against app_users.username.",
  })
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @ApiProperty({
    example: "admin",
    description:
      "Account password. Length policy is enforced by Supabase Auth project settings — not re-validated here.",
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
