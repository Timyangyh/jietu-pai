const DEFAULT_ANALYSIS_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export function analysisRequestTimeoutMs(): number {
  return readTimeoutMs("STYLEME_ANALYSIS_REQUEST_TIMEOUT_MS", DEFAULT_ANALYSIS_REQUEST_TIMEOUT_MS);
}

export function imageRequestTimeoutMs(): number {
  return readTimeoutMs("STYLEME_IMAGE_REQUEST_TIMEOUT_MS", DEFAULT_IMAGE_REQUEST_TIMEOUT_MS);
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  options: { timeoutMs: number; label: string }
): Promise<Response> {
  const controller = new AbortController();
  const existingSignal = init.signal;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${options.label} 超时（${formatDuration(options.timeoutMs)}）`));
  }, options.timeoutMs);

  if (existingSignal) {
    if (existingSignal.aborted) {
      clearTimeout(timeout);
      throw abortReason(existingSignal.reason, `${options.label} 已取消`);
    }
    existingSignal.addEventListener(
      "abort",
      () => {
        controller.abort(existingSignal.reason);
      },
      { once: true }
    );
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`${options.label} 超时（${formatDuration(options.timeoutMs)}），第三方 API 未在限定时间内返回。`);
    }
    throw abortReason(error, `${options.label} 请求失败`);
  } finally {
    clearTimeout(timeout);
  }
}

function readTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}分${String(rest).padStart(2, "0")}秒` : `${minutes}分钟`;
}

function abortReason(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error(fallback);
}
