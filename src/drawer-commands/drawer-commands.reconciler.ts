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

  private static readonly OPEN_STATES = ["PENDING", "PUBLISHED", "ACCEPTED"];

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

  private async sweep(): Promise<void> {
    const admin = this.supabase.getAdminClient();
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("drawer_commands")
      .update({ status: "EXPIRED", error_code: "TIMEOUT", completed_at: now })
      .lt("expires_at", now)
      .in("status", DrawerCommandsReconciler.OPEN_STATES)
      .select("id");
    if (error) {
      this.logger.warn(`sweep update failed: ${error.message}`);
      return;
    }
    if (data && data.length > 0) this.logger.log(`expired ${data.length} stale command(s)`);
  }
}
