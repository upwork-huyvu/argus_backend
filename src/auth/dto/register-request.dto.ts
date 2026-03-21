import { IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterRequestDto {
  @ApiProperty({
    example: "Admin User",
    description: "Display name",
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: "new_user",
    description: "Unique username (lowercase/normalized on backend)",
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    example: "P@ssw0rd",
    description: "Plain-text password (backend will hash it)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  password: string;

  @ApiPropertyOptional({
    example: "viewer",
    description: "User role (defaults to viewer)",
    enum: ["treycor_operator", "client_admin", "viewer"],
  })
  @IsOptional()
  @IsIn(["treycor_operator", "client_admin", "viewer"])
  role?: "treycor_operator" | "client_admin" | "viewer";
}

