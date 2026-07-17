import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export const DRONE_STATUSES = ["DOCKED", "IN_FLIGHT", "MAINTENANCE", "UNKNOWN"] as const;
export type DroneStatus = (typeof DRONE_STATUSES)[number];

export class CreateDroneDto {
  @ApiProperty({ example: "ark-02", description: "Ark this drone belongs to." })
  @IsString()
  @MaxLength(64)
  arkId: string;

  @ApiPropertyOptional({
    example: "6f1604cd-84d6-4ac4-9134-d5d03a4c2ad3",
    description:
      "Drawer controller the drone is docked in. Must belong to the same ark. Omit for an undocked drone.",
  })
  @IsOptional()
  @IsUUID()
  drawerControllerId?: string;

  @ApiPropertyOptional({ example: "Mavic Air 2" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ example: "DJI-SN-0001" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @ApiPropertyOptional({ enum: DRONE_STATUSES, default: "DOCKED" })
  @IsOptional()
  @IsIn(DRONE_STATUSES)
  status?: DroneStatus;
}

export class UpdateDroneDto {
  @ApiPropertyOptional({ example: "Mavic Air 2" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @ApiPropertyOptional({ example: "DJI-SN-0001" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @ApiPropertyOptional({ enum: DRONE_STATUSES })
  @IsOptional()
  @IsIn(DRONE_STATUSES)
  status?: DroneStatus;
}

/**
 * Map / unmap a drone to a drawer controller (the physical drawer it sits in).
 * `null` detaches it (e.g. the drone is in flight).
 */
export class AssignDroneDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: "6f1604cd-84d6-4ac4-9134-d5d03a4c2ad3",
    description:
      "Drawer controller id, or null to detach. Must belong to the same ark as the drone.",
  })
  // Allow an explicit null (detach) but validate the uuid when a value is given.
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  drawerControllerId: string | null;
}
