import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import compression from "compression";
import type { Request, Response } from "express";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter";
import { setupSwagger } from "./swagger/setup-swagger";

async function bootstrap() {
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
  // streaming endpoint (it was a no-op without this). The filter returns false
  // for `text/event-stream` so SSE frames are NOT gzip-buffered by the
  // compressor — we only want the flush hook.
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

  await setupSwagger(app);

  const port = Number(config.get<string | number>("PORT") ?? 3000) || 3000;
  // Bind all interfaces so phones/emulators on LAN can reach the API (not only 127.0.0.1).
  await app.listen(port, "0.0.0.0");
  const local = `http://localhost:${port}`;
  // eslint-disable-next-line no-console
  console.log(
    `[ArgusBE] listening on 0.0.0.0:${port} | Swagger UI: ${local}/docs | OpenAPI JSON: ${local}/docs-json`,
  );
}
bootstrap();
