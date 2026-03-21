import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ROLE_PERMISSIONS, type UserRole } from "../common/permissions";
import { type DeploymentType } from "../common/deployment-types";
import { DeploymentsService } from "../deployments/deployments.service";

type ToggleArgs = {
  userId: string;
  role: string;
  accessToken: string;
  deploymentId: DeploymentType;
  missionId: string;
};

type DuplicateArgs = {
  userId: string;
  role: string;
  accessToken: string;
  deploymentId: DeploymentType;
  missionId: string;
};

@Injectable()
export class MissionsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly deployments: DeploymentsService,
  ) {}

  async toggleMission(args: ToggleArgs) {
    const role = this.asRole(args.role);
    if (!ROLE_PERMISSIONS[role].canToggle) throw new ForbiddenException("Forbidden.");

    // Hydrate and locate mission.
    const deployment = await this.deployments.getDeploymentById(args.userId, args.deploymentId, args.accessToken);
    const mission = deployment.missions.find((m) => m.id === args.missionId);
    if (!mission) throw new NotFoundException("Unknown deployment or mission id.");

    const userClient = this.supabase.getUserClient(args.accessToken);
    const nextEnabled = !mission.enabled;

    const { data, error } = await userClient
      .from("deployment_missions")
      .update({ enabled: nextEnabled })
      .eq("user_id", args.userId)
      .eq("deployment_type", args.deploymentId)
      .eq("id", args.missionId)
      .select("id,enabled")
      .maybeSingle<{ id: string; enabled: boolean }>();

    if (error || !data) throw new NotFoundException("Unknown deployment or mission id.");

    const updated = await this.deployments.getDeploymentById(args.userId, args.deploymentId, args.accessToken);
    return { deployment: updated };
  }

  async duplicateMission(args: DuplicateArgs) {
    const role = this.asRole(args.role);
    if (!ROLE_PERMISSIONS[role].canDuplicate) throw new ForbiddenException("Forbidden.");

    const deployment = await this.deployments.getDeploymentById(args.userId, args.deploymentId, args.accessToken);
    const source = deployment.missions.find((m) => m.id === args.missionId);
    if (!source) throw new NotFoundException("Unknown mission id.");

    // Enforce max custom missions per deployment_type and per user.
    const userClient = this.supabase.getUserClient(args.accessToken);
    const { count, error: countErr } = await userClient
      .from("deployment_missions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", args.userId)
      .eq("deployment_type", args.deploymentId)
      .like("id", "custom_%");

    if (countErr) throw new BadRequestException("Custom mission limit reached.");

    const customCount = count ?? 0;
    if (customCount >= deployment.constraints.maxCustomMissions) {
      throw new BadRequestException("Custom mission limit reached.");
    }

    const customId = `custom_${Date.now()}`;
    const cloneName = `${source.name} (Copy)`;

    const { error: insertErr } = await userClient.from("deployment_missions").insert({
      user_id: args.userId,
      deployment_type: args.deploymentId,
      id: customId,
      name: cloneName,
      description: source.description,
      duration: source.duration,
      enabled: false,
      editable: true,
      customizable: true,
    });

    if (insertErr) {
      // Most likely: RLS denied custom insert (role mismatch).
      throw new BadRequestException("Custom mission limit reached.");
    }

    const updated = await this.deployments.getDeploymentById(args.userId, args.deploymentId, args.accessToken);
    return { deployment: updated };
  }

  private asRole(role: string): UserRole {
    if (role === "treycor_operator" || role === "client_admin" || role === "viewer") return role;
    throw new ForbiddenException("Forbidden.");
  }
}

