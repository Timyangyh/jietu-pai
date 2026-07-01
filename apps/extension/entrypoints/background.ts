import { browser } from "wxt/browser";

const PICK_IMAGE_MENU_ID = "styleme-pick-image";
const LOCAL_API_BASE = "http://127.0.0.1:8787";

export default defineBackground({
  type: "module",
  main() {
    browser.runtime.onInstalled.addListener(async () => {
      await browser.contextMenus.removeAll();
      await browser.contextMenus.create({
        id: PICK_IMAGE_MENU_ID,
        title: "用照样拍选这张图",
        contexts: ["image", "page"]
      });
    });

    browser.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId !== PICK_IMAGE_MENU_ID || !tab?.id) return;
      await browser.tabs.sendMessage(tab.id, {
        type: "STYLEME_CONTEXT_SELECT",
        srcUrl: info.srcUrl,
        pageUrl: info.pageUrl
      });
    });

    browser.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === "STYLEME_CAPTURE_VISIBLE_TAB") {
        const windowId = sender.tab?.windowId;
        return windowId === undefined
          ? browser.tabs.captureVisibleTab({ format: "png" })
          : browser.tabs.captureVisibleTab(windowId, { format: "png" });
      }

      if (message?.type === "STYLEME_DOWNLOAD" && typeof message.url === "string") {
        return browser.downloads.download({
          url: message.url,
          filename: message.filename,
          saveAs: false
        });
      }

      if (message?.type === "STYLEME_LOCAL_API") {
        return proxyLocalApi(message);
      }

      if (message?.type === "STYLEME_OPEN_OVERLAY") {
        return openOverlayInActiveTab();
      }

      return undefined;
    });
  }
});

async function proxyLocalApi(message: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  if (!isLocalApiMessage(message)) {
    return buildProxyError(400, "Invalid local API request");
  }
  const method = message.method ?? "GET";
  if (!["GET", "POST"].includes(method)) {
    return buildProxyError(405, "Unsupported local API method");
  }

  try {
    const response = await fetch(`${LOCAL_API_BASE}${message.path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(typeof message.body === "string" ? { body: message.body } : {})
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text()
    };
  } catch (error) {
    return buildProxyError(502, error instanceof Error ? error.message : "Local API request failed");
  }
}

function isLocalApiMessage(value: unknown): value is { path: string; method?: string; body?: string } {
  if (!value || typeof value !== "object") return false;
  const message = value as { path?: unknown; method?: unknown; body?: unknown };
  return (
    typeof message.path === "string" &&
    message.path.startsWith("/") &&
    !message.path.startsWith("//") &&
    (message.method === undefined || typeof message.method === "string") &&
    (message.body === undefined || typeof message.body === "string")
  );
}

function buildProxyError(status: number, error: string): { ok: false; status: number; text: string } {
  return {
    ok: false,
    status,
    text: `${JSON.stringify({ ok: false, error })}\n`
  };
}

async function openOverlayInActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: "STYLEME_OPEN_OVERLAY" });
  } catch {
    // System pages and tabs opened before installation may not have a content script.
  }
}
