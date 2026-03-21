import { Injectable } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";

type ArkRow = {
  id: string;
  name: string;
  location: string;
  status: "online" | "offline";
  power: number;
  network: string;
  core_temp: number;
  dock_status: "locked" | "unlocked";
  drone_count: number;
  threat_level: "low" | "medium" | "high";
  last_sync: string;
  firmware: string;
  operator: string;
  deployment_type: string;
  hero_image: string | null;
  perimeter_status: string | null;
  visitor_monitoring: string | null;
  lpr: string | null;
  night_patrol: string | null;
  gate_integration: string | null;
};

@Injectable()
export class ArksService {
  constructor(private readonly supabase: SupabaseService) {}

  async getArks(accessToken: string) {
    const userClient = this.supabase.getUserClient(accessToken);

    const { data } = await userClient
      .from("arks")
      .select(
        "id,name,location,status,power,network,core_temp,dock_status,drone_count,threat_level,last_sync,firmware,operator,deployment_type,hero_image,perimeter_status,visitor_monitoring,lpr,night_patrol,gate_integration",
      )
      .order("id", { ascending: true });

    const rows = (data ?? []) as ArkRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      status: r.status,
      power: r.power,
      network: r.network,
      coreTemp: r.core_temp,
      dockStatus: r.dock_status,
      droneCount: r.drone_count,
      threatLevel: r.threat_level,
      lastSync: r.last_sync,
      firmware: r.firmware,
      operator: r.operator,
      deploymentType: r.deployment_type,
      heroImage: r.hero_image ?? null,
      perimeterStatus: r.perimeter_status ?? null,
      visitorMonitoring: r.visitor_monitoring ?? null,
      lpr: r.lpr ?? null,
      nightPatrol: r.night_patrol ?? null,
      gateIntegration: r.gate_integration ?? null,
    }));
  }
}

