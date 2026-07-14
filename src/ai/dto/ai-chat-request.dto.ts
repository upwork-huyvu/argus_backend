import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { DEPLOYMENT_TYPES, type DeploymentType } from "../../common/deployment-types";

class MissionInputDto {
  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}

// ---------------------------------------------------------------------------
// Client-supplied context (NEW)
//
// FE sends time / location / live drone state with each request so the LLM
// can ground "what time is it", "where am I", "is the drone connected" etc.
// All fields are optional → backward compatible: clients that don't send
// `client_context` get the same behavior as before.
// ---------------------------------------------------------------------------

class CoordsDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsNumber()
  accuracy_m?: number;
}

class DroneStateDto {
  @IsOptional()
  @IsBoolean()
  connected?: boolean;

  @IsOptional()
  @IsNumber()
  battery_pct?: number;

  @IsOptional()
  @IsNumber()
  altitude_m?: number;

  @IsOptional()
  @IsNumber()
  satellite_count?: number;

  @IsOptional()
  @IsNumber()
  drone_latitude?: number;

  @IsOptional()
  @IsNumber()
  drone_longitude?: number;

  @IsOptional()
  @IsString()
  model?: string;
}

export class ClientContextDto {
  /** ISO 8601 timestamp from the device wall clock (e.g. 2026-04-29T15:32:08+07:00). */
  @IsOptional()
  @IsString()
  now_iso?: string;

  /** IANA timezone name (e.g. "Asia/Ho_Chi_Minh"). */
  @IsOptional()
  @IsString()
  timezone?: string;

  /** BCP-47 locale (e.g. "vi-VN"). */
  @IsOptional()
  @IsString()
  locale?: string;

  /** Phone GPS reading at request time. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordsDto)
  phone_location?: CoordsDto;

  /** Optional reverse-geocoded label. */
  @IsOptional()
  @IsString()
  phone_location_label?: string;

  /** Live drone snapshot — replaces the deprecated top-level `drone_state` field. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DroneStateDto)
  drone_state?: DroneStateDto;

  /** Route name the user is currently on (e.g. "ArgusAI"). */
  @IsOptional()
  @IsString()
  current_route?: string;
}

export class AiChatRequestDto {
  // No hard length cap: a spoken question can be long (Scribe commits a whole
  // utterance on VAD silence; the protocol does not bound length). The client
  // logs the transcript length, so an abnormally long one is diagnosable there.
  @IsString()
  user_message: string;

  @IsOptional()
  @IsString()
  project_id?: string;

  @IsOptional()
  @IsString()
  drone_id?: string;

  @IsOptional()
  @IsString()
  deployment_id?: DeploymentType;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MissionInputDto)
  @IsArray()
  available_missions?: MissionInputDto[];

  /**
   * @deprecated Use `client_context.drone_state` instead.
   * Kept for backward compatibility with old clients; ignored by the service
   * when `client_context.drone_state` is present.
   */
  @IsOptional()
  @IsObject()
  drone_state?: Record<string, unknown>;

  /** NEW — grounding info from the device. See ClientContextDto. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ClientContextDto)
  client_context?: ClientContextDto;
}

export function isValidDeploymentId(value: string | undefined): value is DeploymentType {
  if (!value) return false;
  return (DEPLOYMENT_TYPES as readonly string[]).includes(value);
}
