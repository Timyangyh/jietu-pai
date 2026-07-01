import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = path.join(projectRoot, "apps/extension/.output/chrome-mv3");
const target = path.join(projectRoot, "照样拍插件-本地加载版");

await fs.access(path.join(source, "manifest.json"));
await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true });

console.log(`Chrome 插件已同步到：${target}`);
