import { Injectable } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { type DeploymentType } from "../common/deployment-types";

type DashboardKpiRow = {
  label: string;
  value: string;
  change: string;
};

@Injectable()
export class DashboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getKpis(_userId: string, deploymentId: DeploymentType, accessToken: string) {
    const userClient = this.supabase.getUserClient(accessToken);

    const { data } = await userClient
      .from("dashboard_kpis")
      .select("label,value,change")
      .eq("deployment_type", deploymentId)
      .order("label", { ascending: true });

    return (data ?? []) as DashboardKpiRow[];
  }
}

