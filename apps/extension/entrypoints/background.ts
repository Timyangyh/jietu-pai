import { browser } from "wxt/browser";

const PICK_IMAGE_MENU_ID = "styleme-pick-image";

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

      if (message?.type === "STYLEME_OPEN_OVERLAY") {
        return openOverlayInActiveTab();
      }

      return undefined;
    });
  }
});

async function openOverlayInActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: "STYLEME_OPEN_OVERLAY" });
  } catch {
    // System pages and tabs opened before installation may not have a content script.
  }
}
