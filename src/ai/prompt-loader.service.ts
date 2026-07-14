import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads the three Argus prompt files from `argus_backend/prompts/` once at
 * boot and exposes them as raw strings. The OpenAI request layer pushes them
 * as separate `system` messages so the model sees:
 *
 *   [system: runtime instructions / response schema]   ← ai-chat.runtime.prompt.txt
 *   [system: app knowledge — screens / routes / flows] ← argus.detail.prompt.txt
 *   [system: drone feature catalog / parameter shapes] ← drone.features.prompt.txt
 *   [system: dynamic CONTEXT block built per request]
 *   [...history...]
 *   [user: current message]
 *
 * Files are resolved relative to this compiled module so it works in both
 * `ts-node` (src/) and `dist/` builds.
 *
 * IMPORTANT: the runtime prompt is REQUIRED. If `ai-chat.runtime.prompt.txt`
 * is missing the loader throws and the API surfaces a 500 — by design.
 * Chat without a schema-constrained system prompt produces invalid envelopes
 * and breaks the FE handler. Fail loud so missing-asset deploys are caught
 * immediately. The two knowledge prompts (app detail / drone features) are
 * best-effort: the loader logs and returns "" if missing.
 */
@Injectable()
export class PromptLoaderService {
  private readonly logger = new Logger(PromptLoaderService.name);

  // Cached file contents. `null` until first read attempt.
  private runtimePrompt: string | null = null;
  private appDetailPrompt: string | null = null;
  private droneFeaturesPrompt: string | null = null;

  // ── Public accessors ────────────────────────────────────────────────────

  /**
   * Canonical system prompt: response schema + type rules + action catalog.
   * Throws InternalServerErrorException if the file is missing or empty.
   */
  getRuntimePrompt(): string {
    if (this.runtimePrompt == null) {
      this.runtimePrompt = this.readPromptRequired(
        'ai-chat.runtime.prompt.txt',
      );
    }
    return this.runtimePrompt;
  }

  /** App knowledge: screens, navigation, flows. Optional — empty string when missing. */
  getAppDetailPrompt(): string {
    if (this.appDetailPrompt == null) {
      this.appDetailPrompt = this.readPromptOptional('argus.detail.prompt.txt');
    }
    return this.appDetailPrompt;
  }

  /** Drone feature catalog: SDK calls, parameter shapes, ranges. Optional. */
  getDroneFeaturesPrompt(): string {
    if (this.droneFeaturesPrompt == null) {
      this.droneFeaturesPrompt = this.readPromptOptional(
        'drone.features.prompt.txt',
      );
    }
    return this.droneFeaturesPrompt;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Read a file that MUST exist. Throws a structured 500 on miss. */
  private readPromptRequired(filename: string): string {
    const txt = this.tryRead(filename);
    if (txt && txt.trim().length > 0) return txt;
    const tried = this.candidatePaths(filename).join('\n  ');
    const msg =
      `Required prompt file not found or empty: ${filename}. ` +
      `Tried:\n  ${tried}\n` +
      `Make sure the deploy artifact includes argus_backend/prompts/, or set PROMPTS_DIR.`;
    this.logger.error(msg);
    throw new InternalServerErrorException({
      message: 'AI assistant is misconfigured: runtime prompt missing.',
      filename,
      hint: 'Check that argus_backend/prompts/ai-chat.runtime.prompt.txt is shipped with the build.',
    });
  }

  /** Read a file that MAY be absent. Logs a warning and returns "" on miss. */
  private readPromptOptional(filename: string): string {
    const txt = this.tryRead(filename);
    if (txt && txt.length > 0) return txt;
    this.logger.warn(
      `Optional prompt not found: ${filename} — continuing without it. ` +
        `(Affects model grounding quality; chat still works.)`,
    );
    return '';
  }

  /** Walk candidate paths; first existing readable file wins. */
  private tryRead(filename: string): string | null {
    for (const p of this.candidatePaths(filename)) {
      try {
        if (fs.existsSync(p)) {
          const txt = fs.readFileSync(p, 'utf8');
          this.logger.log(
            `Loaded prompt: ${filename} (${txt.length} chars) from ${p}`,
          );
          return txt;
        }
      } catch (err) {
        this.logger.warn(
          `Failed reading prompt ${p}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
    return null;
  }

  /**
   * Resolution order (first match wins):
   *
   * If the operator sets `PROMPTS_DIR`, it is **exclusive** — we never fall
   * back to bundled paths. This makes prod deploys deterministic (point at a
   * mounted volume → fail fast if the volume is empty) and lets tests pivot
   * the loader at an isolated temp directory without seeing the repo's real
   * `prompts/` folder.
   *
   * Otherwise we try, in order:
   *   1. dist/ runtime → ../../prompts/<file>          (compiled JS in dist/ai/)
   *   2. ts-node dev   → ../../../prompts/<file>       (src/ai/)
   *   3. process.cwd() → prompts/<file>                (when run from repo root)
   */
  private candidatePaths(filename: string): string[] {
    const envOverride = process.env.PROMPTS_DIR;
    if (envOverride && envOverride.trim().length > 0) {
      return [path.resolve(envOverride.trim(), filename)];
    }
    return [
      path.resolve(__dirname, '..', '..', 'prompts', filename),
      path.resolve(__dirname, '..', '..', '..', 'prompts', filename),
      path.resolve(process.cwd(), 'prompts', filename),
    ];
  }
}
