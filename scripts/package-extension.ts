import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = path.join(projectRoot, "照样拍插件-本地加载版");
const packageDir = path.join(projectRoot, "release-assets");
const stagingDir = path.join(projectRoot, ".tmp/extension-package");
const zipRootDir = path.join(stagingDir, "chrome-mv3");
const packagePath = path.join(packageDir, "jietu-pai-chrome-mv3.zip");
const forbiddenPackageNames = new Set([
  ".env",
  ".git",
  "runs",
  "local-jobs",
  "codex-jobs",
  "local-library",
  "provider-settings.json",
  "gallery.json"
]);
const forbiddenPackagePatterns = [/\.env\./, /token/i, /secret/i, /api[-_]?key/i, /history/i];

await fs.access(path.join(extensionDir, "manifest.json"));
await assertSafePackageSource(extensionDir);
await fs.mkdir(packageDir, { recursive: true });
await fs.rm(stagingDir, { recursive: true, force: true });
await fs.rm(packagePath, { force: true });
await fs.mkdir(zipRootDir, { recursive: true });
await fs.cp(extensionDir, zipRootDir, { recursive: true });
await assertSafePackageSource(zipRootDir);

await zipDirectory(stagingDir, packagePath);

console.log(`Chrome 插件包已生成：${packagePath}`);
console.log("注意：这是插件前端包，完整使用仍需要启动本地服务。");

async function assertSafePackageSource(sourceDir: string): Promise<void> {
  const unsafeEntries: string[] = [];
  await walk(sourceDir, async (entryPath) => {
    const relativePath = path.relative(sourceDir, entryPath);
    const segments = relativePath.split(path.sep);
    const fileName = path.basename(entryPath);
    const hasForbiddenName = segments.some((segment) => forbiddenPackageNames.has(segment));
    const hasForbiddenPattern = forbiddenPackagePatterns.some((pattern) => pattern.test(relativePath) || pattern.test(fileName));
    if (hasForbiddenName || hasForbiddenPattern) unsafeEntries.push(relativePath);
  });

  if (unsafeEntries.length > 0) {
    throw new Error(`插件包包含疑似本地私人数据或历史文件：${unsafeEntries.slice(0, 10).join(", ")}`);
  }
}

async function walk(dir: string, visit: (entryPath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    await visit(entryPath);
    if (entry.isDirectory()) await walk(entryPath, visit);
  }
}

async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("zip", ["-qr", outputPath, "."], {
      cwd: sourceDir,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`zip failed with exit code ${code}`));
    });
  });
}
