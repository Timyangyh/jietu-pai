import { once } from "node:events";
import { createStyleMeServer } from "./server";

const port = Number(process.env.STYLEME_LOCAL_PORT ?? 8787);
const server = createStyleMeServer({ port });

const startedServer = await startServerOrUseExisting(server, port);

const response = await fetch(`http://127.0.0.1:${port}/health`);
if (!response.ok) {
  throw new Error(`Health check failed: ${response.status}`);
}
const body = (await response.json()) as { ok?: boolean };
if (body.ok !== true) {
  throw new Error("Health check returned ok=false");
}

if (startedServer) {
  server.close();
  await once(server, "close");
}
console.log("Local server smoke test passed");

async function startServerOrUseExisting(server: ReturnType<typeof createStyleMeServer>, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(true));
    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1");
  });
}
