import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = process.env.STYLEME_PROJECT_ROOT
  ? path.resolve(process.env.STYLEME_PROJECT_ROOT)
  : path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export const runsRoot = path.join(projectRoot, "runs");
export const codexJobsRoot = path.join(runsRoot, "codex-jobs");
export const localJobsRoot = path.join(runsRoot, "local-jobs");
export const localLibraryRoot = path.join(runsRoot, "local-library");

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativeToProjectRoot(absolutePath: string): string {
  return toPosixPath(path.relative(projectRoot, absolutePath));
}

export function assertInsideProject(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes project root");
  }
  return resolved;
}

export function fileUrl(relativePath: string): string {
  return `/v1/files?path=${encodeURIComponent(relativePath)}`;
}
