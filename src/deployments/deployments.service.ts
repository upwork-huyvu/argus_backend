import { Injectable, NotFoundException } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { type DeploymentType } from "../common/deployment-types";

type MissionTemplateRow = {
  id: string;
  name: string;
  description: string;
  duration: string;
  enabled: boolean;
  editable: boolean;
  customizable: boolean;
};

type DeploymentTypeRow = {
  id: DeploymentType;
  name: string;
  location: string;
  max_custom_missions: number;
  can_edit_missions: boolean;
  can_toggle_missions: boolean;
};

type DeploymentMissionRow = {
  id: string;
  name: string;
  description: string;
  duration: string;
  enabled: boolean;
  editable: boolean;
  customizable: boolean;
};

type DeploymentProfile = {
  id: DeploymentType;
  name: string;
  location: string;
  missions: DeploymentMissionRow[];
  constraints: {
    maxCustomMissions: number;
    canEditMissions: boolean;
    canToggleMissions: boolean;
  };
};

@Injectable()
export class DeploymentsService {
  constructor(private readonly supabase: SupabaseService) {}

  async getDeployments(userId: string, accessToken: string): Promise<DeploymentProfile[]> {
    const admin = this.supabase.getAdminClient();
    const { data: deploymentTypes } = await admin
      .from("deployment_types")
      .select("id,name,location,max_custom_missions,can_edit_missions,can_toggle_missions");

    const list = (deploymentTypes ?? []) as DeploymentTypeRow[];

    const results: DeploymentProfile[] = [];
    for (const dep of list) {
      results.push(await this.ensureHydratedDeployment(userId, accessToken, dep.id));
    }
    return results;
  }

  async getDeploymentById(userId: string, deploymentId: DeploymentType, accessToken: string) {
    return this.ensureHydratedDeployment(userId, accessToken, deploymentId);
  }

  private async ensureHydratedDeployment(
    userId: string,
    accessToken: string,
    deploymentId: DeploymentType,
  ): Promise<DeploymentProfile> {
    const admin = this.supabase.getAdminClient();
    const userClient = this.supabase.getUserClient(accessToken);

    // Validate deployment exists (admin bypass).
    const { data: depType, error: depErr } = await admin
      .from("deployment_types")
      .select(
        "id,name,location,max_custom_missions,can_edit_missions,can_toggle_missions",
      )
      .eq("id", deploymentId)
      .maybeSingle<DeploymentTypeRow>();

    if (depErr || !depType) throw new NotFoundException("Unknown deployment id.");

    // Get template missions for this deployment (must exist in DB).
    const { data: templates, error: templatesErr } = await userClient
      .from("mission_templates")
      .select("id,name,description,duration,enabled,editable,customizable")
      .eq("deployment_type", deploymentId)
      .order("id", { ascending: true });

    if (templatesErr) {
      // If the user client is blocked by RLS, treat it as server misconfig.
      throw new NotFoundException("Unknown deployment id.");
    }

    const templateList = (templates ?? []) as MissionTemplateRow[];

    // Existing missions for this user+deployment.
    const { data: existing, error: existingErr } = await userClient
      .from("deployment_missions")
      .select("id,name,description,duration,enabled,editable,customizable")
      .eq("user_id", userId)
      .eq("deployment_type", deploymentId);

    if (existingErr) throw new NotFoundException("Unknown deployment id.");

    const existingSet = new Set((existing ?? []).map((m) => m.id));

    // Insert missing template missions (hydration).
    const missing = templateList.filter((t) => !existingSet.has(t.id));
    if (missing.length > 0) {
      const insertRows = missing.map((t) => ({
        user_id: userId,
        deployment_type: deploymentId,
        id: t.id,
        name: t.name,
        description: t.description,
        duration: t.duration,
        enabled: t.enabled,
        editable: t.editable,
        customizable: t.customizable,
      }));

      const { error: insertErr } = await userClient
        .from("deployment_missions")
        .insert(insertRows);

      if (insertErr) {
        // Common case: RLS not configured or token mismatch.
        throw new NotFoundException("Unknown deployment id.");
      }
    }

    // Fetch hydrated missions.
    const { data: hydrated, error: hydratedErr } = await userClient
      .from("deployment_missions")
      .select("id,name,description,duration,enabled,editable,customizable")
      .eq("user_id", userId)
      .eq("deployment_type", deploymentId)
      .order("created_at", { ascending: true })
      ;

    if (hydratedErr) throw new NotFoundException("Unknown deployment id.");

    return {
      id: depType.id,
      name: depType.name,
      location: depType.location,
      missions: hydrated ?? [],
      constraints: {
        maxCustomMissions: depType.max_custom_missions,
        canEditMissions: depType.can_edit_missions,
        canToggleMissions: depType.can_toggle_missions,
      },
    };
  }
}

