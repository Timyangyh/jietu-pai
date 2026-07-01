import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "照样拍 本地版",
    short_name: "照样拍",
    description: "从网页参考图和人物图生成本地写真结果，配合本地服务使用。",
    version: "0.1.3",
    permissions: ["activeTab", "tabs", "storage", "contextMenus", "downloads"],
    host_permissions: ["<all_urls>", "http://127.0.0.1:8787/*"],
    action: {
      default_title: "照样拍"
    }
  }
});
