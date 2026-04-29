// ---------------------------------------------------------------------------
// The canonical system prompt lives in
//   argus_backend/prompts/ai-chat.runtime.prompt.txt
// and is read at runtime by `PromptLoaderService.getRuntimePrompt()`. There
// is NO inline fallback: if the file is missing the loader throws so the
// deploy issue surfaces immediately as a 500. Keep the .txt file shipped
// with every deployment artifact (see `PromptLoaderService.candidatePaths`).
// ---------------------------------------------------------------------------
// Dynamic CONTEXT block — built per request from the FE's `client_context`
// plus server-resolved missions. Pushed to OpenAI as a separate `system`
// message so it never gets confused with the static instruction prompt.
// ---------------------------------------------------------------------------

export type ContextNavRoute = {
  /** Route name as registered in `RootStackParamList` (case-sensitive). */
  route: string;
  /** Short user-facing label. */
  label: string;
  /** One-line description of what the screen does. */
  description: string;
  /** Optional gate ("requires_drone_connected"). */
  requires?: string;
};

export type ContextInput = {
  availableMissions: Array<{ id: string; name: string; description?: string }>;
  deploymentType?: string;
  /** ISO 8601 timestamp from the device's wall clock. */
  nowIso?: string;
  /** IANA timezone, e.g. "Asia/Ho_Chi_Minh". */
  timezone?: string;
  /** BCP-47 locale, e.g. "vi-VN". */
  locale?: string;
  /** Phone GPS at request time. */
  phoneLocation?: {
    latitude: number;
    longitude: number;
    accuracyM?: number;
    /** Optional reverse-geocoded label. */
    label?: string;
  };
  /** Live drone state snapshot from the FE's DJI bridge. */
  droneState?: {
    connected: boolean;
    batteryPct?: number;
    altitudeM?: number;
    satelliteCount?: number;
    droneLatitude?: number;
    droneLongitude?: number;
    model?: string;
  };
  /** Route name the user is currently on. */
  currentRoute?: string;
  /** Allowed navigation targets — the model is told to use only these. */
  navCatalog?: ContextNavRoute[];
};

function fmtCoord(n: number): string {
  return Number.isFinite(n) ? n.toFixed(5) : "?";
}

export function buildContextBlock(ctx: ContextInput): string {
  const lines: string[] = ["== CONTEXT =="];

  // --- Time / locale -------------------------------------------------------
  if (ctx.nowIso) {
    const tz = ctx.timezone ?? "UTC";
    const locale = ctx.locale ?? "en-US";
    lines.push(`NOW: ${ctx.nowIso} (${tz}, locale ${locale})`);
  } else {
    lines.push("NOW: unavailable (client did not send now_iso)");
  }

  // --- Deployment / route --------------------------------------------------
  lines.push(`DEPLOYMENT: ${ctx.deploymentType ?? "unspecified"}`);
  if (ctx.currentRoute) {
    lines.push(`CURRENT_ROUTE: ${ctx.currentRoute}`);
  }

  // --- Phone location ------------------------------------------------------
  if (ctx.phoneLocation) {
    const { latitude, longitude, accuracyM, label } = ctx.phoneLocation;
    const acc = accuracyM != null ? `, ±${Math.round(accuracyM)}m` : "";
    const lab = label ? ` (${label})` : "";
    lines.push(`PHONE_LOCATION: ${fmtCoord(latitude)}, ${fmtCoord(longitude)}${acc}${lab}`);
  } else {
    lines.push("PHONE_LOCATION: unavailable");
  }

  // --- Drone state ---------------------------------------------------------
  if (ctx.droneState) {
    const d = ctx.droneState;
    const parts = [
      `connected=${d.connected}`,
      d.model ? `model=${d.model}` : null,
      d.batteryPct != null ? `battery=${d.batteryPct}%` : null,
      d.altitudeM != null ? `alt=${d.altitudeM.toFixed(1)}m` : null,
      d.satelliteCount != null ? `sat=${d.satelliteCount}` : null,
      d.droneLatitude != null && d.droneLongitude != null
        ? `pos=${fmtCoord(d.droneLatitude)},${fmtCoord(d.droneLongitude)}`
        : null,
    ].filter(Boolean);
    lines.push(`DRONE_STATE: ${parts.join(" ")}`);
  } else {
    lines.push("DRONE_STATE: unavailable");
  }

  // --- Available missions --------------------------------------------------
  if (ctx.availableMissions.length > 0) {
    const mlist = ctx.availableMissions
      .map(
        (m) =>
          `  ${m.id} | ${m.name}${
            m.description ? ` — ${m.description.slice(0, 60)}` : ""
          }`,
      )
      .join("\n");
    lines.push(
      `AVAILABLE_MISSIONS (${ctx.availableMissions.length} total):\n${mlist}`,
    );
  } else {
    lines.push("AVAILABLE_MISSIONS: none loaded for this deployment");
  }

  // --- Navigation catalog --------------------------------------------------
  if (ctx.navCatalog && ctx.navCatalog.length > 0) {
    const lines2 = ctx.navCatalog
      .map(
        (n) =>
          `  ${n.route} | ${n.label} — ${n.description}${
            n.requires ? ` [${n.requires}]` : ""
          }`,
      )
      .join("\n");
    lines.push(`NAVIGATION_CATALOG (use route name verbatim):\n${lines2}`);
  } else {
    lines.push(
      "NAVIGATION_CATALOG: none — do NOT return type=navigation in this turn",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default navigation catalog. Mirrors `RootStackParamList` keys we want the
// AI to be allowed to navigate to. Bottom-tab routes (Dashboard / LiveView /
// MissionsV2 / Map / Alerts) plus a curated set of stack screens. Keeping
// this server-side means we can change the allowlist without an app rebuild.
// ---------------------------------------------------------------------------
export const DEFAULT_NAV_CATALOG: ContextNavRoute[] = [
  { route: "Dashboard",   label: "Dashboard", description: "KPIs, alerts preview, quick actions" },
  { route: "LiveView",    label: "Live View", description: "Camera grid (Single / Split / Grid)" },
  { route: "MissionsV2",  label: "Missions",  description: "Mission Center — list, filter, run missions" },
  { route: "Map",         label: "Map",       description: "Real-time drone map with phone GPS overlay" },
  { route: "Alerts",      label: "Alerts",    description: "System alerts feed" },
  { route: "ArgusAI",     label: "Argus AI",  description: "This chat screen" },
  { route: "Settings",    label: "Settings",  description: "App settings root" },
  { route: "EditProfile", label: "Edit profile", description: "Profile editor" },
  { route: "ChatInbox",   label: "Chat",      description: "Chat threads inbox" },
  { route: "FAA",         label: "FAA",       description: "FAA airspace / NOTAM info" },
  { route: "HelpCenter",  label: "Help",      description: "FAQ + support" },
  { route: "Deployment",  label: "Deployment", description: "Pick the active deployment" },
  { route: "DroneControl",  label: "Pilot mode",      description: "Full-screen pilot with virtual sticks", requires: "requires_drone_connected" },
  { route: "DroneSettings", label: "Drone settings",  description: "DJI safety / camera tuning",            requires: "requires_drone_connected" },
];

/** Allowlist used for validating LLM-returned routes server-side. */
export const NAV_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set(
  DEFAULT_NAV_CATALOG.map((r) => r.route),
);
