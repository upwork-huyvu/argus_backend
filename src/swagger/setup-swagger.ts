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
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: "Argus API Docs",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[swagger] setup failed (routes not registered):", (err as Error)?.stack ?? err);
  }
}
