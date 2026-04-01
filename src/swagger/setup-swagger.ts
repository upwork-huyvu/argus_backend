import type { INestApplication } from "@nestjs/common";
import path from "node:path";

/**
 * Absolute path to `swagger-ui-dist` so static assets resolve in production
 * (Vercel serverless file-tracing often skips nested node_modules paths).
 */
function swaggerUiDistDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkgJson = require.resolve("swagger-ui-dist/package.json");
  return path.dirname(pkgJson);
}

/** Resolve concrete files so Vercel / @vercel/nft traces the whole swagger-ui-dist tree. */
function traceSwaggerUiDistFiles(distDir: string): void {
  const files = [
    "swagger-ui-bundle.js",
    "swagger-ui-standalone-preset.js",
    "swagger-ui.css",
    "swagger-ui-initializer.js",
    "oauth2-redirect.html",
  ];
  for (const f of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require.resolve(path.join(distDir, f));
  }
}

/**
 * Swagger UI at `/docs`. OpenAPI JSON at `/docs-json`.
 *
 * Root `/` redirects to `/docs` (see AppController) so browser bookmarks keep working.
 */
export async function setupSwagger(app: INestApplication) {
  try {
    const distDir = swaggerUiDistDir();
    traceSwaggerUiDistFiles(distDir);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const swagger = require("@nestjs/swagger") as any;
    // Side effect: ensures package is traced by bundlers
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("swagger-ui-express");

    const { DocumentBuilder, SwaggerModule } = swagger;

    const config = new DocumentBuilder()
      .setTitle("Argus Backend")
      .setDescription("NestJS + Supabase MVP API for the Argus RN app")
      .setVersion("0.0.1")
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "bearerAuth",
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup("docs", app, document, {
      customSwaggerUiPath: distDir,
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: "Argus API Docs",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[swagger] Disabled (missing deps):", (err as Error)?.message ?? err);
  }
}
