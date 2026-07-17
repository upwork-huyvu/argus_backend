import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupabaseService } from "../common/supabase/supabase.service";

/**
 * Periodically expires commands stuck past their deadline. This is the safety
 * net for lost command-results (QoS1, not retained) and backend restarts — a
 * command never hangs in PENDING/PUBLISHED/ACCEPTED forever.
 * See docs/ESP32_DEVICE_MVP_PLAN.md §5, §15 Phase 5.
 *
 * Plain setInterval — avoids adding @nestjs/schedule for one job.
 */
@Injectable()
export class DrawerCommandsReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrawerCommandsReconciler.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;


  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.intervalMs = Number(this.config.get<string>("COMMAND_RECONCILE_INTERVAL_MS") ?? 10_000);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((e) =>
        this.logger.error(`reconcile sweep failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, this.intervalMs);
    // Don't keep the event loop alive just for the sweeper.
    this.timer.unref?.();
    this.logger.log(`reconciler started (every ${this.intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Expire in three passes so each command says WHERE it got stuck. A bare
   * "TIMEOUT" with no message forces the reader to guess whether the broker, the
   * device, or the hardware was at fault.
   */
  private async sweep(): Promise<void> {
    const now = new Date().toISOString();

    const passes: Array<{ statuses: string[]; message: string }> = [
      {
        // Never published: the broker was unreachable, so the device never saw it.
        statuses: ["PENDING"],
        message: "Expired before it could be published to the broker — the device never received it.",
      },
      {
        // Published but the device never acknowledged: offline, not subscribed,
        // or it rejected the command without reporting back.
        statuses: ["PUBLISHED"],
        message: "Published to the broker, but the device never acknowledged it (no ACCEPTED).",
      },
      {
        // Accepted then went quiet: it started, and either the hardware hung or
        // the result was lost (results are QoS1 and not retained).
        statuses: ["ACCEPTED"],
        message: "Device accepted the command but never reported a result — it may have stalled mid-move.",
      },
    ];

    let total = 0;
    for (const pass of passes) {
      const { data, error } = await this.supabase
        .getAdminClient()
        .from("drawer_commands")
        .update({
          status: "EXPIRED",
          error_code: "TIMEOUT",
          error_message: pass.message,
          completed_at: now,
        })
        .lt("expires_at", now)
        .in("status", pass.statuses)
        .select("id");
      if (error) {
        this.logger.warn(`sweep (${pass.statuses.join(",")}) failed: ${error.message}`);
        continue;
      }
      total += data?.length ?? 0;
    }
    if (total > 0) this.logger.log(`expired ${total} stale command(s)`);
  }
}
