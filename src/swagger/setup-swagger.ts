import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import path from "node:path";
// Keep express peer in the module graph for Vercel / bundlers (SwaggerModule uses it internally).
import "swagger-ui-express";

/**
 * Absolute path to `swagger-ui-dist`, or `undefined` to use @nestjs/swagger default resolver.
 */
function trySwaggerUiDistDir(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgJson = require.resolve("swagger-ui-dist/package.json");
    return path.dirname(pkgJson);
  } catch {
    return undefined;
  }
}

/** Best-effort: hint file tracers; must never throw or Swagger routes never register. */
function traceSwaggerUiDistFilesBestEffort(distDir: string): void {
  const files = [
    "swagger-ui-bundle.js",
    "swagger-ui-standalone-preset.js",
    "swagger-ui.css",
    "swagger-ui-initializer.js",
    "oauth2-redirect.html",
  ];
  for (const f of files) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require.resolve(path.join(distDir, f));
    } catch {
      // ignore — file may be absent in trimmed serverless bundles
    }
  }
}

/**
 * Swagger UI at `/docs`. OpenAPI JSON at `/docs-json`.
 * Root `/` redirects to `/docs` (AppController).
 */
export async function setupSwagger(app: INestApplication) {
  try {
    const distDir = trySwaggerUiDistDir();
    if (distDir) {
      traceSwaggerUiDistFilesBestEffort(distDir);
    }

    const config = new DocumentBuilder()
      .setTitle("Argus Backend")
      .setDescription("NestJS + Supabase MVP API for the Argus RN app")
      .setVersion("0.0.1")
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "bearerAuth",
      )
      // Shared device key for ESP32 registration (X-Controller-Key).
      .addApiKey({ type: "apiKey", in: "header", name: "X-Controller-Key" }, "controllerKey")
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup("docs", app, document, {
      ...(distDir ? { customSwaggerUiPath: distDir } : {}),
      swaggerOptions: {
        persistAuthorization: true,
        /**
         * Auto-fill Idempotency-Key with a fresh UUID on every "Execute".
         *
         * Without this you either type one by hand or reuse a constant — and a
         * reused key replays the first command forever instead of sending a new
         * one. Runs in the browser: @nestjs/swagger serializes this function into
         * the Swagger init script.
         */
        requestInterceptor: (req: { headers?: Record<string, string> }) => {
          const h = req.headers ?? (req.headers = {});
          const key = Object.keys(h).find((k) => k.toLowerCase() === "idempotency-key");
          const uuid =
            (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ??
            "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            });
          // Only fill it in when the user left it blank; a key they typed on
          // purpose (to test a replay) must be preserved.
          if (!key || !h[key]) h["Idempotency-Key"] = uuid;
          return req;
        },
      },
      customSiteTitle: "Argus API Docs",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[swagger] setup failed (routes not registered):", (err as Error)?.stack ?? err);
  }
}
