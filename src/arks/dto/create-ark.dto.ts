import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DEPLOYMENT_TYPES } from "../../common/deployment-types";

export const ARK_STATUSES = ["online", "offline"] as const;
export const ARK_DOCK_STATUSES = ["locked", "unlocked"] as const;
export const ARK_THREAT_LEVELS = ["low", "medium", "high"] as const;

/**
 * Admin-only: create an ark owned by `userId`.
 *
 * The `arks` table has many NOT NULL columns without defaults, so anything the
 * admin omits is filled with a sensible default in ArksService (see DEFAULTS).
 */
export class CreateArkDto {
  @ApiProperty({
    example: "0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    description: "Owner (app_users.id). The ark is created for this user.",
  })
  @IsUUID()
  userId: string;

  @ApiPropertyOptional({
    example: "ark-04",
    description:
      "Business id (text primary key). Omit to auto-generate 'ark-<8 hex>'. Must be unique.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: "id may only contain letters, digits, '.', '_' or '-'",
  })
  id?: string;

  @ApiProperty({ example: "ARK-04 Orlando" })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiProperty({ example: "Orlando, FL" })
  @IsString()
  @MaxLength(200)
  location: string;

  @ApiProperty({
    example: "commercial",
    description: `Deployment type. Accepted (case-insensitive): ${DEPLOYMENT_TYPES.join(", ")}.`,
  })
  @IsString()
  @MaxLength(64)
  deploymentType: string;

  // ─── Optional operational fields (defaulted when omitted) ──────────────────

  @ApiPropertyOptional({ enum: ARK_STATUSES, default: "offline" })
  @IsOptional()
  @IsIn(ARK_STATUSES)
  status?: (typeof ARK_STATUSES)[number];

  @ApiPropertyOptional({ enum: ARK_DOCK_STATUSES, default: "locked" })
  @IsOptional()
  @IsIn(ARK_DOCK_STATUSES)
  dockStatus?: (typeof ARK_DOCK_STATUSES)[number];

  @ApiPropertyOptional({ enum: ARK_THREAT_LEVELS, default: "low" })
  @IsOptional()
  @IsIn(ARK_THREAT_LEVELS)
  threatLevel?: (typeof ARK_THREAT_LEVELS)[number];

  @ApiPropertyOptional({ example: "Secure LTE", default: "Unknown" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  network?: string;

  @ApiPropertyOptional({ example: 92, minimum: 0, maximum: 100, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  power?: number;

  @ApiPropertyOptional({ example: 38, default: 0 })
  @IsOptional()
  @IsInt()
  coreTemp?: number;

  @ApiPropertyOptional({ example: 3, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  droneCount?: number;

  @ApiPropertyOptional({ example: "Mavic Air 2" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  droneModel?: string;

  @ApiPropertyOptional({ example: "12:42 PM", description: "Defaults to now (ISO)." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastSync?: string;

  @ApiPropertyOptional({ example: "v1.0.3", default: "v0.0.0" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firmware?: string;

  @ApiPropertyOptional({ example: "Capt. Daniel Reyes", default: "Unassigned" })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  operator?: string;

  @ApiPropertyOptional({ example: "/assets/original/arv_1.png" })
  @IsOptional()
  @IsString()
  heroImage?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() perimeterStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() visitorMonitoring?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lpr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nightPatrol?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gateIntegration?: string;
}
