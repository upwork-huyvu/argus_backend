import { IsEmail } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ForgotPasswordDto {
  @ApiProperty({
    example: "operator@argus.io",
    description: "Email to send the Supabase password-reset link to.",
  })
  @IsEmail()
  email: string;
}
