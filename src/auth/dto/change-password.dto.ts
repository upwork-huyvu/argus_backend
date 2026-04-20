import { IsNotEmpty, IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ChangePasswordDto {
  @ApiProperty({
    example: "CurrentP@ss1",
    description: "Current password — required to re-confirm the session.",
  })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({
    example: "N3wP@ssw0rd!",
    description: "New password — min 8 chars.",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}
