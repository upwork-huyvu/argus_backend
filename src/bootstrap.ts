import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import compression from "compression";
import type { Request, Response } from "express";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter";
import { setupSwagger } from "./swagger/setup-swagger";

/**
 * Builds and configures the Nest application WITHOUT starting an HTTP listener.
 * Shared by the long-running standalone/dev server ({@link file://./main.ts},
 * which then calls `app.listen`) and the Vercel serverless entry
 * (`api/index.ts`, which calls `app.init()` and hands the Express instance to
 * `serverless-http`). A single factory guarantees both paths apply identical
 * filters, pipes, CORS and middleware.
 *
 * @param opts.swagger mount Swagger UI — dev only; skipped in the serverless
 *                     path to trim cold-start bundle + boot time (FR-6).
 */
export async function createNestApp(
  opts: { swagger?: boolean } = {},
): Promise<INestApplication> {
  const { swagger = true } = opts;
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: true,
    }),
  );

  // Register compression so `res.flush()` is a real function on the SSE
  // streaming endpoint (FR-4). The filter returns false for `text/event-stream`
  // so SSE frames are NOT buffered/gzipped by the compressor — we only want the
  // flush hook + to guarantee the stream is never gzip-buffered on Vercel.
  app.use(
    compression({
      filter: (req: Request, res: Response) => {
        const contentType = res.getHeader("Content-Type");
        if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  const corsOrigin = config.get<string>("CORS_ORIGIN");
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : true,
    credentials: false,
  });

  if (swagger) {
    await setupSwagger(app);
  }

  return app;
}
