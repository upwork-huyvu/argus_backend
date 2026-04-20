import { IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { USER_ROLES, type UserRole } from "../../common/permissions";

export class UpdateRoleDto {
  @ApiProperty({ enum: USER_ROLES, example: "OPERATOR" })
  @IsIn(USER_ROLES)
  role: UserRole;
}
