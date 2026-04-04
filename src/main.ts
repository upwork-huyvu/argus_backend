import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
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
