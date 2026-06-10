import type { IncomingMessage, ServerResponse } from "http";
import { createNestApp } from "../src/bootstrap";

/**
 * Vercel serverless entry (FR-3/FR-6, OQ-3/OQ-4).
 *
 * Vercel's `@vercel/node` runtime invokes this default export with raw Node
 * `req`/`res` — which an Express application consumes directly — so we bootstrap
 * Nest once, grab the underlying Express instance, and hand the request to it.
 * (No `serverless-http`: that adapts AWS Lambda's `event`/`context` shape, which
 * Vercel does not use.)
 *
 * The initialized app is memoized in module scope so only a COLD start pays the
 * bootstrap cost; warm invocations reuse it. Swagger is skipped here to trim the
 * cold-start bundle + boot time. `app.init()` wires routes + global pipes /
 * filters / compression WITHOUT binding a port (no `app.listen`).
 *
 * The long-running standalone server (`src/main.ts`) is untouched and still
 * powers local dev and any non-Vercel host.
 */

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<NodeRequestHandler> | undefined;

async function buildExpressApp(): Promise<NodeRequestHandler> {
  const app = await createNestApp({ swagger: false });
  await app.init();
  // The default Nest platform is Express; its instance is itself a (req,res) handler.
  return app.getHttpAdapter().getInstance() as NodeRequestHandler;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!appPromise) appPromise = buildExpressApp();
    const expressApp = await appPromise;
    expressApp(req, res);
  } catch (error) {
    // A failed cold-start bootstrap must not be cached forever — clear it so the
    // next invocation retries instead of serving 500s for the life of the warm
    // instance.
    appPromise = undefined;
    // eslint-disable-next-line no-console
    console.error(
      `[api] bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ statusCode: 500, message: "Server failed to start." }));
  }
}
