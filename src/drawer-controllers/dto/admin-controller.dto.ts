import { IsIn, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AssignControllerDto {
  @ApiProperty({ example: "ark-01", description: "Ark id to assign this controller to." })
  @IsString()
  @MaxLength(120)
  arkId: string;
}

export class SetLifecycleStatusDto {
  @ApiProperty({ enum: ["UNASSIGNED", "ACTIVE", "DISABLED"] })
  @IsIn(["UNASSIGNED", "ACTIVE", "DISABLED"])
  lifecycleStatus: "UNASSIGNED" | "ACTIVE" | "DISABLED";
}
