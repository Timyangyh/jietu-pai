import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStyleMeServer } from "./server";

const port = Number(process.env.STYLEME_LOCAL_PORT ?? 8787);
const server = createStyleMeServer({ port });

server.listen(port, "127.0.0.1", () => {
  console.log(`StyleMe local server listening on http://127.0.0.1:${port}`);
});

startSourceRefreshWatcher();

function shutdown(signal: NodeJS.Signals): void {
  console.log(`StyleMe local server received ${signal}, restarting...`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function startSourceRefreshWatcher(): void {
  if (!shouldWatchSourceChanges()) return;

  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  let scheduled = false;
  try {
    const watcher = fs.watch(srcDir, { recursive: true }, (_event, fileName) => {
      if (!fileName || !/\.(?:ts|tsx|mts|cts)$/.test(String(fileName))) return;
      if (scheduled) return;
      scheduled = true;
      console.log(`StyleMe local server source changed: ${fileName}; restarting...`);
      setTimeout(() => shutdown("SIGTERM"), 100).unref();
    });
    watcher.unref();
  } catch (error) {
    console.warn(`StyleMe local server source watcher disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shouldWatchSourceChanges(): boolean {
  if (process.env.STYLEME_DISABLE_SOURCE_WATCH === "1") return false;
  if (process.env.STYLEME_LOCAL_WATCH === "1") return true;
  return ["dev", "start", "dev:server", "start:server"].includes(process.env.npm_lifecycle_event ?? "");
}
