import { ConfigService } from "@nestjs/config";
import { createNestApp } from "./bootstrap";

async function bootstrap() {
  // Standalone/dev server: build the fully-configured app (Swagger on) and bind
  // a listener. The Vercel serverless entry (`api/index.ts`) reuses the same
  // `createNestApp` factory but calls `app.init()` instead of `app.listen()`.
  const app = await createNestApp({ swagger: true });
  const config = app.get(ConfigService);

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
