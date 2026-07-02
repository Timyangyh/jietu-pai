import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDir = path.join(projectRoot, "release-assets");
const tempRoot = path.join(projectRoot, ".tmp/windows-package");
const nodeCacheDir = path.join(projectRoot, ".tmp/node-runtime");
const extensionDir = path.join(projectRoot, "照样拍插件-本地加载版");
const appVersion = JSON.parse(await fs.readFile(path.join(projectRoot, "apps/extension/package.json"), "utf8")).version as string;
const nodeVersion = process.env.STYLEME_WINDOWS_NODE_VERSION || process.versions.node;
const packageName = `jietu-pai-windows-x64-v${appVersion}`;
const packageRoot = path.join(tempRoot, packageName);
const archivePath = path.join(releaseDir, `${packageName}.zip`);
const archiveShaPath = path.join(releaseDir, `${packageName}.sha256.txt`);
const nodeZipPath = path.join(nodeCacheDir, `node-v${nodeVersion}-win-x64.zip`);
const nodeExtractRoot = path.join(nodeCacheDir, `node-v${nodeVersion}-win-x64`);
const nodeDownloadUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`;

const forbiddenSegments = new Set([
  ".env",
  ".git",
  ".output",
  ".wxt",
  ".cache",
  ".tmp",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "playwright-report",
  "release-assets",
  "runs",
  "test-results",
  "tmp"
]);
const forbiddenFileNames = new Set(["provider-settings.json", "gallery.json"]);
const forbiddenTextPatterns = [
  /\/Users\//,
  /C:\\Users\\/i,
  /gho_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /BEGIN (?:RSA |OPENSSH |PRIVATE )?KEY/
];

await fs.access(path.join(extensionDir, "manifest.json"));
await fs.rm(tempRoot, { recursive: true, force: true });
await fs.mkdir(path.join(packageRoot, "app/server"), { recursive: true });
await fs.mkdir(path.join(packageRoot, "app/chrome-extension"), { recursive: true });
await fs.mkdir(path.join(packageRoot, "node"), { recursive: true });
await fs.mkdir(releaseDir, { recursive: true });

await buildServerBundle();
await copyExtension();
await copyNodeRuntime();
await writePackageFiles();
await assertCleanPackage(packageRoot);
await writeInternalChecksums();
await fs.rm(archivePath, { force: true });
await zipDirectory(tempRoot, archivePath);
const archiveSha = await sha256File(archivePath);
await fs.writeFile(archiveShaPath, `${archiveSha}  ${path.basename(archivePath)}\n`, "utf8");

console.log(`Windows 包已生成：${archivePath}`);
console.log(`SHA256：${archiveSha}`);

async function buildServerBundle(): Promise<void> {
  await build({
    entryPoints: [path.join(projectRoot, "apps/local-server/src/index.ts")],
    outfile: path.join(packageRoot, "app/server/index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none"
  });
}

async function copyExtension(): Promise<void> {
  await fs.cp(extensionDir, path.join(packageRoot, "app/chrome-extension"), { recursive: true });
}

async function copyNodeRuntime(): Promise<void> {
  await fs.mkdir(nodeCacheDir, { recursive: true });
  if (!(await exists(nodeZipPath))) {
    await downloadFile(nodeDownloadUrl, nodeZipPath);
  }

  await fs.rm(nodeExtractRoot, { recursive: true, force: true });
  await fs.mkdir(nodeExtractRoot, { recursive: true });
  await run("unzip", ["-q", nodeZipPath, "-d", nodeExtractRoot]);
  const extractedDir = path.join(nodeExtractRoot, `node-v${nodeVersion}-win-x64`);
  await fs.copyFile(path.join(extractedDir, "node.exe"), path.join(packageRoot, "node/node.exe"));
  await fs.copyFile(path.join(extractedDir, "LICENSE"), path.join(packageRoot, "node/LICENSE.txt"));
}

async function writePackageFiles(): Promise<void> {
  await fs.copyFile(path.join(projectRoot, "LICENSE"), path.join(packageRoot, "LICENSE.txt"));
  await fs.copyFile(path.join(projectRoot, ".env.example"), path.join(packageRoot, "app/.env.example"));
  await fs.writeFile(path.join(packageRoot, "start-local-server.cmd"), windowsStartScript(), "utf8");
  await fs.writeFile(path.join(packageRoot, "README-Windows.md"), windowsReadme(), "utf8");
}

function windowsStartScript(): string {
  return [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    "cd /d \"%~dp0\"",
    "set \"STYLEME_PROJECT_ROOT=%~dp0app\"",
    "set \"STYLEME_LOCAL_PORT=8787\"",
    "set \"STYLEME_DISABLE_SOURCE_WATCH=1\"",
    "",
    "if not exist \"node\\node.exe\" (",
    "  echo Missing node\\node.exe. Please extract the full Windows package again.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "echo Starting Jietu Pai local server...",
    "echo Server: http://127.0.0.1:8787",
    "echo Keep this window open. Press Ctrl+C to stop.",
    "echo.",
    "\"node\\node.exe\" \"app\\server\\index.mjs\"",
    "echo.",
    "echo Local server stopped.",
    "pause"
  ].join("\r\n");
}

function windowsReadme(): string {
  return [
    "# 截图拍 Windows 使用说明",
    "",
    "这个包用于 Windows x64 用户下载后直接使用。包内包含 Chrome 插件前端、本地服务单文件包和官方 Windows Node.js 运行时的 `node.exe`。",
    "",
    "## 使用步骤",
    "",
    "1. 解压整个 zip，不要只打开压缩包内部文件。",
    "2. 双击 `start-local-server.cmd`，保持打开的服务窗口不要关闭。",
    "3. Chrome 打开 `chrome://extensions`。",
    "4. 开启右上角“开发者模式”。",
    "5. 点击“加载已解压的扩展程序”。",
    "6. 选择本包里的 `app\\chrome-extension` 文件夹。",
    "7. 打开普通网页，点击 Chrome 工具栏里的“照样拍 本地版”。",
    "",
    "## 配置 Provider",
    "",
    "- 默认 Mock Provider 不需要 key，可先用来确认插件和本地服务连接正常。",
    "- OpenAI、Gemini、OpenRouter 和自定义 API 可以在插件浮层里的“配置 API”中填写。",
    "- API key 只保存在本机 `app\\runs\\local-library\\provider-settings.json` 或你自己创建的 `app\\.env` 中，不会进入插件包。",
    "",
    "## 本地数据",
    "",
    "运行后生成的图片、Provider 设置和相册记录会保存在 `app\\runs`。分享或重新打包时不要把 `app\\runs` 发给别人。",
    "",
    "## 常见问题",
    "",
    "| 问题 | 处理 |",
    "|---|---|",
    "| 插件显示连接失败 | 确认 `启动本地服务.cmd` 窗口仍在运行 |",
    "| Chrome 不允许加载 | 确认选择的是 `app\\chrome-extension` 文件夹，不是整个 zip |",
    "| 插件打不开 | 不要在 Chrome 设置页、新标签页或 `chrome://` 页面使用 |",
    "| 真实生图失败 | 检查所选 Provider 的 key、baseUrl、模型名和额度 |",
    "",
    "## 安全说明",
    "",
    "这个 Windows 包不包含 `.env`、API key、OAuth token、cookie、历史任务、相册记录、本地上传图片或生成图片。"
  ].join("\n");
}

async function writeInternalChecksums(): Promise<void> {
  const entries = [
    "node/node.exe",
    "app/server/index.mjs",
    "app/chrome-extension/manifest.json",
    "README-Windows.md",
    "start-local-server.cmd"
  ];
  const lines = [];
  for (const entry of entries) {
    lines.push(`${await sha256File(path.join(packageRoot, entry))}  ${entry}`);
  }
  await fs.writeFile(path.join(packageRoot, "checksums.txt"), `${lines.join("\n")}\n`, "utf8");
}

async function assertCleanPackage(root: string): Promise<void> {
  const problems: string[] = [];
  await walk(root, async (entryPath, dirent) => {
    const relativePath = path.relative(root, entryPath);
    const parts = relativePath.split(path.sep);
    const fileName = path.basename(entryPath);
    if (parts.some((segment) => forbiddenSegments.has(segment)) || forbiddenFileNames.has(fileName)) {
      problems.push(relativePath);
      return;
    }
    if (!dirent.isFile() || fileName.endsWith(".exe")) return;
    if (!(await isTextFile(entryPath))) return;
    const content = await fs.readFile(entryPath, "utf8");
    if (forbiddenTextPatterns.some((pattern) => pattern.test(content))) {
      problems.push(relativePath);
    }
  });

  if (problems.length > 0) {
    throw new Error(`Windows 包包含疑似本地私有数据或不应发布文件：${problems.slice(0, 20).join(", ")}`);
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  console.log(`下载 Windows Node 运行时：${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, buffer);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function isTextFile(filePath: string): Promise<boolean> {
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) return false;
  return buffer.length < 5 * 1024 * 1024;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, visit: (entryPath: string, dirent: import("node:fs").Dirent) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    await visit(entryPath, entry);
    if (entry.isDirectory()) await walk(entryPath, visit);
  }
}

async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  await run("zip", ["-qr", outputPath, packageName], sourceDir);
}

async function run(command: string, args: string[], cwd = projectRoot): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}
