import { OmitType, PartialType } from "@nestjs/swagger";
import { CreateArkDto } from "./create-ark.dto";

/**
 * Admin-only: update an ark. Every field is optional; only what you send is
 * changed. `id` is immutable (it is the primary key and is referenced by
 * drawer_controllers / drones / drawer_commands), so it is omitted here.
 *
 * `userId` IS updatable — sending it transfers ownership to another user.
 */
export class UpdateArkDto extends PartialType(OmitType(CreateArkDto, ["id"] as const)) {}
