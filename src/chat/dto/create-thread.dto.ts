import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateThreadDto {
  /**
   * Target user's auth.users.id. BE verifies they hold OPERATOR or ADMIN role
   * before allowing thread creation.
   */
  @ApiProperty({ example: "1c0e5a…", description: "Target operator/admin user id." })
  @IsUUID()
  operatorId: string;

  @ApiProperty({
    example: "Request patrol for Zone B entrance",
    description: "One-line subject shown in the inbox list.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  subject: string;

  @ApiPropertyOptional({
    example: "We need a patrol sweep for Zone B — motion alerts near loading dock.",
    description: "Optional first message to include with the thread.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  initialMessage?: string;
}
