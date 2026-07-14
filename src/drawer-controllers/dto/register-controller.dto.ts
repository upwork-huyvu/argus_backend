import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

class HardwareDto {
  @ApiPropertyOptional({ example: "ESP32-S3" })
  @IsOptional()
  @IsString()
  chipModel?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  chipRevision?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  cores?: number;

  @ApiPropertyOptional({ example: 8388608 })
  @IsOptional()
  @IsInt()
  flashSize?: number;
}

class FirmwareDto {
  @ApiPropertyOptional({ example: "0.1.0" })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({ example: "2026-07-14" })
  @IsOptional()
  @IsString()
  build?: string;
}

class NetworkDto {
  @ApiPropertyOptional({ example: "192.168.1.23" })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: -61 })
  @IsOptional()
  @IsInt()
  wifiRssi?: number;
}

class BootDto {
  @ApiPropertyOptional({ example: "random-value-per-boot" })
  @IsOptional()
  @IsString()
  bootId?: string;

  @ApiPropertyOptional({ example: "POWER_ON" })
  @IsOptional()
  @IsString()
  resetReason?: string;
}

/**
 * Registration payload for `PUT /drawer-provisioning/:mac`.
 * The MAC is taken from the URL, NOT the body. No Wi-Fi/MQTT secrets here.
 */
export class RegisterControllerDto {
  @ApiPropertyOptional({ example: "ARGUS-ESP32-001", description: "Metadata only; not unique." })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @ApiProperty({ example: "DRAWER_CONTROLLER" })
  @IsString()
  @MaxLength(64)
  controllerType: string;

  @ApiPropertyOptional({ type: HardwareDto })
  @IsOptional()
  @IsObject()
  hardware?: HardwareDto;

  @ApiPropertyOptional({ type: FirmwareDto })
  @IsOptional()
  @IsObject()
  firmware?: FirmwareDto;

  @ApiPropertyOptional({ example: ["DRAWER_OPEN", "DRAWER_CLOSE", "LIGHT_ON", "LIGHT_OFF"] })
  @IsOptional()
  @IsArray()
  capabilities?: string[];

  @ApiPropertyOptional({ type: NetworkDto })
  @IsOptional()
  @IsObject()
  network?: NetworkDto;

  @ApiPropertyOptional({ type: BootDto })
  @IsOptional()
  @IsObject()
  boot?: BootDto;
}
