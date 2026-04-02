import { Type } from "class-transformer";
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
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

export class AiChatRequestDto {
  @IsString()
  @MaxLength(1000)
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

  @IsOptional()
  @IsObject()
  drone_state?: Record<string, unknown>;
}

export function isValidDeploymentId(value: string | undefined): value is DeploymentType {
  if (!value) return false;
  return (DEPLOYMENT_TYPES as readonly string[]).includes(value);
}
