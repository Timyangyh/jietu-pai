import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./paths";

let loaded = false;
export const projectEnvPath = path.join(projectRoot, ".env");

export function loadProjectEnv(): void {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(projectEnvPath)) return;

  const content = fs.readFileSync(projectEnvPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripEnvQuotes(match[2] ?? "");
  }
}

export async function removeProjectEnvKeys(keys: string[]): Promise<string[]> {
  const keySet = new Set(keys);
  for (const key of keySet) {
    delete process.env[key];
  }

  let content: string;
  try {
    content = await fsp.readFile(projectEnvPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const removed: string[] = [];
  const hadTrailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  const nextLines = lines.filter((line, index) => {
    if (index === lines.length - 1 && line === "" && hadTrailingNewline) return false;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/);
    if (!match?.[1] || !keySet.has(match[1])) return true;
    removed.push(match[1]);
    return false;
  });

  await fsp.writeFile(projectEnvPath, `${nextLines.join("\n")}${nextLines.length ? "\n" : ""}`, "utf8");
  return removed;
}

function stripEnvQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
