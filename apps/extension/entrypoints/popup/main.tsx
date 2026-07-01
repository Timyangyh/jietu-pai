import "./style.css";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BadgeCheck, ExternalLink, RefreshCw, Server, Settings, XCircle } from "lucide-react";
import { browser } from "wxt/browser";
import { getHealth, getProviderSettings, type HealthResponse, type ProviderSettingsResponse } from "../../src/lib/api";

function Popup() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [providers, setProviders] = useState<ProviderSettingsResponse | null>(null);
  const [error, setError] = useState("");
  const [overlayError, setOverlayError] = useState("");

  async function refresh() {
    try {
      setError("");
      const [nextHealth, nextProviders] = await Promise.all([getHealth(), getProviderSettings()]);
      setHealth(nextHealth);
      setProviders(nextProviders);
    } catch (err) {
      setHealth(null);
      setProviders(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openOverlay() {
    setOverlayError("");
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setOverlayError("没有可操作的当前网页。");
      return;
    }

    if (!isNormalWebPage(tab.url)) {
      setOverlayError("先打开一个普通网页，再点“打开网页浮层”。Chrome 设置页、扩展管理页和新标签页不能注入插件浮层。");
      return;
    }

    try {
      await browser.tabs.sendMessage(tab.id, { type: "STYLEME_OPEN_OVERLAY" });
      window.close();
    } catch {
      setOverlayError("当前网页还没加载插件脚本。刷新这个网页后再点一次，或直接点网页右下角的“照样拍”。");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main>
      <header>
        <strong>照样拍</strong>
        <button type="button" onClick={refresh} title="刷新">
          <RefreshCw size={16} />
        </button>
      </header>

      <section className={health?.ok ? "status ok" : "status"}>
        {health?.ok ? <BadgeCheck size={18} /> : <XCircle size={18} />}
        <div>
          <strong>{health?.ok ? "本地服务已连接" : "本地服务未连接"}</strong>
          <span>{health?.ok ? "127.0.0.1:8787" : error}</span>
        </div>
      </section>

      <button className="primary" type="button" onClick={openOverlay}>
        <ExternalLink size={16} />
        <span>打开网页浮层</span>
      </button>
      {overlayError && <p className="inline-error">{overlayError}</p>}

      <section className="meta">
        <div>
          <Server size={14} />
          <span>127.0.0.1:8787</span>
        </div>
        <div>
          <Settings size={14} />
          <span>Provider</span>
          <strong>{providers?.providers.find((provider) => provider.active)?.label ?? health?.activeProvider ?? "未知"}</strong>
        </div>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Popup />);

function isNormalWebPage(url?: string): boolean {
  if (!url) return false;
  return /^(https?:|file:)/.test(url);
}
