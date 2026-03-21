import type { INestApplication } from "@nestjs/common";

/**
 * Sets up Swagger UI at `/api-docs`.
 *
 * We `require()` swagger deps so the backend can still boot even if
 * `@nestjs/swagger` / `swagger-ui-express` haven't been installed yet.
 */
export async function setupSwagger(app: INestApplication) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const swagger = require("@nestjs/swagger") as any;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const swaggerUI = require("swagger-ui-express");

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

    SwaggerModule.setup("/api-docs", app, document, {
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: "Argus API Docs",
      // `swagger-ui-express` is used internally by SwaggerModule,
      // but requiring it keeps the dependency explicit.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      customCssUrl: swaggerUI ? undefined : undefined,
    });
  } catch (err) {
    // If deps aren't installed yet, keep server booting.
    // eslint-disable-next-line no-console
    console.warn("[swagger] Disabled (missing deps):", (err as Error)?.message ?? err);
  }
}

