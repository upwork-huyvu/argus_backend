import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";

/**
 * Mirrors RN `Partial<Record<DeploymentType, PublicCamera[]>>` — keys are deployment ids.
 */
export class PutPublicRtspDto {
  @ApiProperty({
    description: "Map of deployment id → list of public RTSP cameras",
    example: {
      construction: [{ id: "1730000000", name: "Gate", url: "rtsp://...", note: "" }],
    },
  })
  @IsObject()
  byDeployment!: Record<string, unknown>;
}
