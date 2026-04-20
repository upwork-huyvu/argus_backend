import { IsEmail, IsNotEmpty, IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginRequestDto {
  @ApiProperty({
    example: "operator@argus.io",
    description: "Email address used for Supabase Auth sign-in.",
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: "P@ssw0rd1!",
    description: "Account password.",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}
