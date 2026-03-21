import { Injectable } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { type DeploymentType } from "../common/deployment-types";

type SystemAlertRow = {
  id: string;
  title: string;
  message: string;
  time: string;
  tone: "critical" | "warning" | "success" | "info";
};

@Injectable()
export class AlertsService {
  constructor(private readonly supabase: SupabaseService) {}

  async getAlerts(_userId: string, deploymentId: DeploymentType, accessToken: string) {
    const userClient = this.supabase.getUserClient(accessToken);

    const { data } = await userClient
      .from("system_alerts")
      .select("id,title,message,time,tone")
      .eq("deployment_type", deploymentId)
      .order("time", { ascending: true });

    return (data ?? []) as SystemAlertRow[];
  }
}

