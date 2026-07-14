import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export const DRAWER_COMMAND_TYPES = [
  "DRAWER_OPEN",
  "DRAWER_CLOSE",
  "LIGHT_ON",
  "LIGHT_OFF",
] as const;

export type DrawerCommandType = (typeof DRAWER_COMMAND_TYPES)[number];

export class CreateDrawerCommandDto {
  @ApiProperty({ enum: DRAWER_COMMAND_TYPES, example: "DRAWER_OPEN" })
  @IsIn(DRAWER_COMMAND_TYPES)
  type: DrawerCommandType;

  @ApiPropertyOptional({
    example: 15,
    minimum: 5,
    maximum: 60,
    description: "Command lifetime in seconds. Device rejects/ignores after this.",
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(60)
  expiresInSeconds?: number;
}
