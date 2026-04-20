import { IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RefreshTokenDto {
  @ApiProperty({
    description: "Supabase refresh token returned from /auth/login.",
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
