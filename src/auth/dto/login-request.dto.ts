import { IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginRequestDto {
  @ApiProperty({
    example: "admin",
    description: "Username used to authenticate",
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    example: "admin",
    description: "Password used to authenticate",
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}

