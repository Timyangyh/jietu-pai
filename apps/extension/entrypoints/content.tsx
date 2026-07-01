import "../src/styles/content.css";
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  AlertTriangle,
  BadgeCheck,
  Camera,
  Clock,
  Download,
  FlaskConical,
  Heart,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { ImageProviderMode, LocalFileAsset, LocalGenerationJobManifest, QualityScore, StyleRecipe } from "@styleme/core";
import { browser } from "wxt/browser";
import {
  absoluteLocalUrl,
  analyzeRecipe,
  createCodexJob,
  createGeneration,
  deleteJob,
  deleteOutput,
  getProviderSettings,
  getHealth,
  listJobs,
  refreshCodexJob,
  refreshJob,
  retryGeneration,
  saveCodexReview,
  saveReview,
  saveProviderSettings,
  setFavorite,
  type ImagePayload,
  type ProviderSettingsResponse,
  type ReferenceSource,
  type ThirdPartyProviderKey,
  type ThirdPartyProviderSummary
} from "../src/lib/api";
import { cropDataUrl, prepareImageFile, type PreparedImage } from "../src/lib/image";

interface ReferenceCandidate {
  kind: "image" | "background" | "screenshot";
  sourceUrl?: string;
  dataUrl?: string;
  previewUrl: string;
  fileName: string;
  altText?: string;
  rect?: DOMRect;
}

interface HoverState {
  candidate: ReferenceCandidate;
  rect: DOMRect;
}

interface PreviewState {
  job: LocalGenerationJobManifest;
  output: LocalFileAsset;
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  cssInjectionMode: "ui",
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: "styleme-local-overlay",
      position: "inline",
      anchor: "body",
      onMount(container) {
        const app = document.createElement("div");
        app.id = "styleme-extension-root";
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(<StyleMeOverlay />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      }
    });
    ui.mount();
  }
});

function StyleMeOverlay() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [reference, setReference] = useState<ReferenceCandidate | null>(null);
  const [recipe, setRecipe] = useState<StyleRecipe | null>(null);
  const [subjects, setSubjects] = useState<PreparedImage[]>([]);
  const [count, setCount] = useState(4);
  const [jobs, setJobs] = useState<LocalGenerationJobManifest[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [extensionInvalidated, setExtensionInvalidated] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsResponse | null>(null);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  const activeJob = useMemo(
    () => jobs.find((job) => job.jobId === activeJobId) ?? jobs[0] ?? null,
    [activeJobId, jobs]
  );
  const activeProvider = useMemo(
    () => providerSettings?.providers.find((provider) => provider.active) ?? null,
    [providerSettings]
  );
  const activeThirdPartyProvider = useMemo(
    () => providerSettings?.thirdPartyProviders.find((provider) => provider.active) ?? null,
    [providerSettings]
  );
  const selectedProviderMode = providerSettings?.activeProvider ?? "mock";
  const generationElapsedMs = generationStartedAt ? nowMs - generationStartedAt : null;

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (open) return;
      const candidate = detectReferenceCandidate(event.target);
      if (!candidate?.rect) {
        setHover(null);
        return;
      }
      setHover({ candidate, rect: candidate.rect });
    };

    const handleMessage = (message: { type?: string; srcUrl?: string; pageUrl?: string }) => {
      if (message.type === "STYLEME_OPEN_OVERLAY") {
        setExtensionInvalidated(false);
        setOpen(true);
        return;
      }

      if (message.type === "STYLEME_CONTEXT_SELECT" && message.srcUrl) {
        const next: ReferenceCandidate = {
          kind: "image",
          sourceUrl: message.srcUrl,
          previewUrl: message.srcUrl,
          fileName: fileNameFromUrl(message.srcUrl),
          altText: document.title
        };
        setReference(next);
        setRecipe(null);
        setOpen(true);
      }
    };

    document.addEventListener("mousemove", handleMove, { passive: true });
    browser.runtime.onMessage.addListener(handleMessage);
    void checkHealth();
    void loadProviderSettings();
    void loadJobs();

    return () => {
      document.removeEventListener("mousemove", handleMove);
      browser.runtime.onMessage.removeListener(handleMessage);
    };
  }, [open]);

  useEffect(() => {
    if (!generationStartedAt) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt]);

  useEffect(() => {
    if (!generationStartedAt) return;
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 4000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt]);

  async function checkHealth() {
    try {
      const result = await getHealth();
      setServerOnline(true);
      if (!providerSettings) {
        setProviderSettings({
          ok: true,
          activeProvider: result.activeProvider,
          providers: [],
          thirdPartyProviders: []
        });
      }
    } catch {
      setServerOnline(false);
    }
  }

  async function loadProviderSettings() {
    try {
      setProviderSettings(await getProviderSettings());
    } catch {
      setProviderSettings(null);
    }
  }

  async function loadJobs(): Promise<LocalGenerationJobManifest[]> {
    try {
      const result = await listJobs();
      setJobs(result.jobs);
      return result.jobs;
    } catch {
      setJobs([]);
      return [];
    }
  }

  function selectReference(candidate: ReferenceCandidate) {
    setReference(candidate);
    setRecipe(null);
    setOpen(true);
    setNotice("已选择参考图");
    setError("");
  }

  async function handleAnalyze() {
    if (!reference) return;
    await withBusy("分析原图", async () => {
      const result = await analyzeRecipe(toImagePayload(reference), buildSource(reference), selectedProviderMode);
      setRecipe(result.recipe);
      setNotice("原图已分析：已提取姿势、服装、光线和构图");
    });
  }

  async function handleSubjectFiles(files: FileList | null) {
    if (!files?.length) return;
    await withBusy("处理人物图", async () => {
      const prepared = await Promise.all(Array.from(files).slice(0, 3).map((file) => prepareImageFile(file)));
      setSubjects(prepared);
      setNotice(`已载入 ${prepared.length} 张人物图`);
    });
  }

  async function handleStartGeneration() {
    if (!reference) {
      setError("先选择参考图");
      return;
    }
    if (subjects.length === 0) {
      setError("先上传人物图");
      return;
    }

    const startedAt = Date.now();
    setGenerationStartedAt(startedAt);
    setNowMs(startedAt);
    setActiveJobId(null);
    try {
      await withBusy("开始生成", async () => {
        const nextRecipe =
          recipe ??
          (
            await analyzeRecipe(toImagePayload(reference), buildSource(reference), selectedProviderMode)
          ).recipe;
        if (!recipe) setRecipe(nextRecipe);

        const result = await createGeneration({
          reference: toImagePayload(reference),
          subjects: subjects.map((subject) => ({
            dataUrl: subject.dataUrl,
            fileName: subject.fileName
          })),
          source: buildSource(reference),
          recipe: nextRecipe,
          count,
          providerMode: selectedProviderMode
        });
        setActiveJobId(result.job.jobId);
        await loadJobs();
        if (result.job.status === "failed") {
          setError(result.job.error ?? "生成失败");
        } else {
          const elapsed = result.job.durationMs ?? Date.now() - startedAt;
          setNotice(`生成完成：${result.job.outputs.length}/${result.job.count} 张，用时 ${formatDuration(elapsed)}`);
        }
      });
    } finally {
      setGenerationStartedAt(null);
    }
  }

  async function handleCreateDebugCodexJob() {
    if (!reference) {
      setError("先选择参考图");
      return;
    }
    if (subjects.length === 0) {
      setError("先上传人物图");
      return;
    }

    await withBusy("创建调试任务包", async () => {
      const result = await createCodexJob({
        reference: toImagePayload(reference),
        subjects: subjects.map((subject) => ({
          dataUrl: subject.dataUrl,
          fileName: subject.fileName
        })),
        source: buildSource(reference),
        count,
        ...(recipe ? { recipe } : {})
      });
      setActiveJobId(result.job.jobId);
      await loadJobs();
      setNotice(`调试任务包已创建：${result.job.rootDir}`);
    });
  }

  async function handleProviderChange(mode: ImageProviderMode) {
    await withBusy("切换 Provider", async () => {
      const result = await saveProviderSettings({ activeProvider: mode });
      setProviderSettings(result);
      setNotice(`Provider 已切换为 ${providerLabel(mode)}`);
    });
  }

  async function handleSaveOpenAIConfig(input: { apiKey?: string; model: string }) {
    await withBusy("保存 Provider 配置", async () => {
      const result = await saveProviderSettings({
        openai: {
          model: input.model,
          ...(input.apiKey ? { apiKey: input.apiKey } : {})
        }
      });
      setProviderSettings(result);
      setNotice("OpenAI 配置已保存到本地服务");
    });
  }

  async function handleClearOpenAIKey() {
    await withBusy("清除 Provider key", async () => {
      const result = await saveProviderSettings({ openai: { clearApiKey: true } });
      setProviderSettings(result);
      setNotice("已清除 OpenAI key；本地设置和项目 .env 中的对应项已移除");
    });
  }

  async function handleSaveThirdPartyConfig(
    key: ThirdPartyProviderKey,
    input: { apiKey?: string; baseUrl: string; model: string; analysisModel: string }
  ) {
    await withBusy("保存 Provider 配置", async () => {
      const result = await saveProviderSettings({
        thirdParty: {
          [key]: {
            baseUrl: input.baseUrl,
            model: input.model,
            analysisModel: input.analysisModel,
            ...(input.apiKey ? { apiKey: input.apiKey } : {})
          }
        }
      });
      setProviderSettings(result);
      setNotice(`${thirdPartyLabel(key)} 配置已保存到本地服务`);
    });
  }

  async function handleSelectThirdPartyConfig(key: ThirdPartyProviderKey) {
    await withBusy("切换第三方 API", async () => {
      const result = await saveProviderSettings({
        activeProvider: "third-party",
        thirdParty: {
          activeConfig: key
        }
      });
      setProviderSettings(result);
      setNotice(`当前第三方 API 已切换为 ${thirdPartyLabel(key)}`);
    });
  }

  async function handleClearThirdPartyKey(key: ThirdPartyProviderKey) {
    await withBusy("清除 Provider key", async () => {
      const result = await saveProviderSettings({
        thirdParty: {
          [key]: { clearApiKey: true }
        }
      });
      setProviderSettings(result);
      setNotice(`已清除 ${thirdPartyLabel(key)} key；本地设置和项目 .env 中的对应项已移除`);
    });
  }

  async function handleRefreshJob(job: LocalGenerationJobManifest) {
    await withBusy("刷新结果", async () => {
      const result = job.providerMode === "codex-dev" ? await refreshCodexJob(job.jobId) : await refreshJob(job.jobId);
      setJobs((current) => [result.job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setActiveJobId(result.job.jobId);
      setNotice("任务状态已刷新");
    });
  }

  async function handleRetryJob(jobId: string) {
    await withBusy("重试生成", async () => {
      const result = await retryGeneration(jobId);
      setJobs((current) => [result.job, ...current.filter((job) => job.jobId !== jobId)]);
      setActiveJobId(result.job.jobId);
      if (result.job.status === "failed" || result.job.status === "dead_letter") {
        setError(result.job.error ?? "重试失败");
      } else {
        setNotice(`重试完成：${result.job.outputs.length}/${result.job.count} 张`);
      }
    });
  }

  async function handleFavorite(jobId: string, output: LocalFileAsset) {
    await withBusy("更新收藏", async () => {
      await setFavorite(jobId, output.id, !output.favorite);
      await loadJobs();
      setNotice(output.favorite ? "已取消收藏" : "已收藏");
    });
  }

  async function handleDeleteOutput(jobId: string, output: LocalFileAsset) {
    const job = jobs.find((item) => item.jobId === jobId);
    await withBusy("隐藏图片", async () => {
      await deleteOutput(jobId, output.id, job?.providerMode);
      setPreview((current) => (current?.job.jobId === jobId && current.output.id === output.id ? null : current));
      setJobs((current) =>
        current.map((item) =>
          item.jobId === jobId
            ? {
                ...item,
                outputs: item.outputs.filter((candidate) => candidate.id !== output.id)
              }
            : item
        )
      );
      await loadJobs();
      setNotice("图片已从插件相册隐藏，本地文件保留");
    });
  }

  async function handleDeleteJob(job: LocalGenerationJobManifest) {
    await withBusy("隐藏任务", async () => {
      try {
        await deleteJob(job.jobId, job.providerMode);
      } catch (err) {
        if (!isRouteNotFoundError(err)) throw err;
        setNotice("当前本地服务未加载隐藏任务接口；已临时隐藏。重启本地服务后可持久隐藏。");
      }
      setPreview((current) => (current?.job.jobId === job.jobId ? null : current));
      setJobs((current) => current.filter((item) => item.jobId !== job.jobId));
      const nextJobs = await loadJobs();
      const visibleJobs = nextJobs.filter((item) => item.jobId !== job.jobId);
      setActiveJobId((current) => (current === job.jobId ? visibleJobs[0]?.jobId ?? null : current));
      setJobs(visibleJobs);
      setNotice((current) => current || "任务已从插件相册隐藏，本地目录保留");
    });
  }

  async function handleDownload(job: LocalGenerationJobManifest, output: LocalFileAsset) {
    const url = absoluteLocalUrl(output.url ?? "");
    const filename = `styleme/${job.createdAt.slice(0, 10)}-${safeFileName(job.title)}-${output.id}${extensionFromFile(output.fileName)}`;
    await browser.runtime.sendMessage({
      type: "STYLEME_DOWNLOAD",
      url,
      filename
    });
  }

  async function markJobUsable(job: LocalGenerationJobManifest) {
    const scores: Record<string, QualityScore> = Object.fromEntries(
      job.outputs.map((output) => [
        output.id,
        {
          styleScore: 4,
          identityScore: 4,
          qualityScore: 4,
          usabilityScore: 4,
          risk: "pass",
          failureReasons: [],
          notes: "快速评分；最终以用户判断为准"
        }
      ])
    );
    await withBusy("保存评分", async () => {
      if (job.providerMode === "codex-dev") {
        await saveCodexReview(job.jobId, scores);
      } else {
        await saveReview(job.jobId, scores);
      }
      await loadJobs();
      setNotice("评分已保存");
    });
  }

  async function startScreenshotSelection() {
    try {
      const rect = await selectViewportRect();
      if (!rect) return;
      const screenshot = (await browser.runtime.sendMessage({ type: "STYLEME_CAPTURE_VISIBLE_TAB" })) as string;
      const cropped = await cropDataUrl(screenshot, rect, window.devicePixelRatio || 1);
      selectReference({
        kind: "screenshot",
        dataUrl: cropped,
        previewUrl: cropped,
        fileName: `screenshot-${Date.now()}.png`,
        altText: document.title
      });
    } catch (err) {
      handleCaughtError(err);
    }
  }

  async function withBusy(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setExtensionInvalidated(false);
    try {
      await action();
    } catch (err) {
      handleCaughtError(err);
    } finally {
      setBusy(null);
    }
  }

  function handleCaughtError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (isExtensionContextInvalidatedError(err)) {
      setExtensionInvalidated(true);
      setError("插件刚被重新加载，当前网页里的旧插件脚本已失效。刷新这个网页后再截图。");
      return;
    }
    setExtensionInvalidated(false);
    if (/分析模型未配置|看图分析模型未配置/.test(message)) {
      setProviderConfigOpen(true);
    }
    setError(message);
  }

  return (
    <>
      {!open && (
        <button className="styleme-launcher" type="button" onClick={() => setOpen(true)} title="打开照样拍">
          <Camera size={18} />
          <span>照样拍</span>
        </button>
      )}

      {!open && hover && (
        <button
          className="styleme-hover-pick"
          data-testid="select-reference"
          style={{ top: Math.max(10, hover.rect.top + 8), left: Math.max(10, hover.rect.left + 8) }}
          type="button"
          onClick={() => selectReference(hover.candidate)}
        >
          <ImageIcon size={14} />
          <span>选用</span>
        </button>
      )}

      {open && (
        <aside className="styleme-panel" aria-label="照样拍本地插件">
          <header className="styleme-header">
            <div>
              <strong>照样拍</strong>
              <span className={serverOnline ? "styleme-dot ok" : "styleme-dot"} />
            </div>
            <button className="styleme-icon-button" type="button" onClick={() => setOpen(false)} title="关闭">
              <X size={18} />
            </button>
          </header>

          {error && (
            <div className="styleme-alert error">
              <span>{error}</span>
              {extensionInvalidated && (
                <button type="button" onClick={() => window.location.reload()} title="刷新网页">
                  刷新网页
                </button>
              )}
            </div>
          )}
          {notice && !error && <div className="styleme-alert">{notice}</div>}

          <section className="styleme-section">
            <div className="styleme-section-title">
              <ImageIcon size={16} />
              <span>参考图</span>
            </div>
            {reference ? (
              <div className="styleme-reference">
                <img src={reference.previewUrl} alt="参考图预览" />
                <div>
                  <strong>{reference.fileName}</strong>
                  <span>{reference.kind === "screenshot" ? "选区截图" : "网页图片"}</span>
                </div>
              </div>
            ) : (
              <div className="styleme-empty">悬停网页图片点“选用”，或截取当前可见区域。</div>
            )}
            <div className="styleme-actions">
              <button type="button" onClick={startScreenshotSelection}>
                <Maximize2 size={16} />
                <span>截图</span>
              </button>
              <button
                className={reference && !recipe ? "styleme-analyze-button" : ""}
                data-testid="analyze-reference"
                type="button"
                disabled={!reference || Boolean(busy)}
                onClick={handleAnalyze}
              >
                {busy === "分析原图" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                <span>{recipe ? "重新分析" : "分析原图"}</span>
              </button>
            </div>
            {reference && !recipe && (
              <div className="styleme-analysis-callout">
                <Sparkles size={15} />
                <span>先分析原图，提取姿势、服装造型、光线和构图后再生成。</span>
              </div>
            )}
          </section>

          {recipe && (
            <section className="styleme-section">
              <div className="styleme-section-title">
                <Sparkles size={16} />
                <span>图片配方</span>
              </div>
              <dl className="styleme-recipe">
                <dt>姿势</dt>
                <dd>{recipe.subject}</dd>
                <dt>场景</dt>
                <dd>{recipe.scene}</dd>
                <dt>光线</dt>
                <dd>{recipe.lighting}</dd>
                <dt>构图</dt>
                <dd>{recipe.composition}</dd>
                <dt>服装</dt>
                <dd>{recipe.outfit}</dd>
                <dt>色彩</dt>
                <dd>{recipe.color}</dd>
              </dl>
            </section>
          )}

          <section className="styleme-section">
            <div className="styleme-section-title">
              <Upload size={16} />
              <span>人物图</span>
            </div>
            <label className="styleme-upload">
              <input
                accept="image/png,image/jpeg,image/webp"
                data-testid="subject-upload-input"
                multiple
                type="file"
                onChange={(event) => handleSubjectFiles(event.target.files)}
              />
              <Upload size={16} />
              <span>选择 1-3 张</span>
            </label>
            {subjects.length > 0 && (
              <div className="styleme-subjects">
                {subjects.map((subject) => (
                  <img key={subject.fileName} src={subject.dataUrl} alt={subject.fileName} />
                ))}
              </div>
            )}
          </section>

          <section className="styleme-section">
            <div className="styleme-section-title">
              <Send size={16} />
              <span>生成任务</span>
            </div>
            <div className="styleme-provider-panel">
              <div className="styleme-provider-status">
                <Settings size={15} />
                <strong>
                  {activeProvider?.mode === "third-party" && activeThirdPartyProvider
                    ? `${activeProvider.label} · ${activeThirdPartyProvider.label}`
                    : activeProvider?.label ?? providerLabel(providerSettings?.activeProvider ?? "mock")}
                </strong>
                <span>{providerStatusLabel(activeProvider?.status)}</span>
              </div>
              <select
                disabled={Boolean(busy)}
                value={providerSettings?.activeProvider ?? "mock"}
                onChange={(event) => handleProviderChange(event.target.value as ImageProviderMode)}
              >
                {(providerSettings?.providers.filter((provider) => provider.mode !== "codex-dev") ?? [
                  { mode: "mock", label: "Mock 占位测试", enabled: true }
                ]).map((provider) => (
                  <option key={provider.mode} value={provider.mode} disabled={!provider.enabled}>
                    {provider.label}
                  </option>
                ))}
              </select>
              {providerSettings?.activeProvider === "third-party" && (
                <label className="styleme-third-party-picker">
                  <span>使用 API</span>
                  <select
                    disabled={Boolean(busy)}
                    value={activeThirdPartyProvider?.key ?? ""}
                    onChange={(event) => handleSelectThirdPartyConfig(event.target.value as ThirdPartyProviderKey)}
                  >
                    {providerSettings.thirdPartyProviders.map((provider) => (
                      <option key={provider.key} value={provider.key} disabled={!provider.enabled}>
                        {provider.label}
                        {provider.configured ? "" : "（未配置）"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {activeProvider?.model && (
                <p>
                  当前模型：{activeProvider.model}
                  {activeProvider.mode === "third-party"
                    ? ` · 看图分析：${activeThirdPartyProvider?.analysisModel || "未配置"}`
                    : ""}
                  {activeProvider.keySource ? ` · key 来源：${keySourceLabel(activeProvider.keySource)}` : ""}
                </p>
              )}
              {activeProvider?.detail && <p>{activeProvider.detail}</p>}
              {providerSettings?.activeProvider === "third-party" && activeThirdPartyProvider && !activeThirdPartyProvider.analysisModel && (
                <div className="styleme-provider-config-warning">
                  <AlertTriangle size={15} />
                  <span>{activeThirdPartyProvider.label} 缺少看图分析模型。</span>
                  <button type="button" onClick={() => setProviderConfigOpen(true)}>
                    填写
                  </button>
                </div>
              )}
              <button className="styleme-secondary compact" type="button" onClick={() => setProviderConfigOpen((value) => !value)}>
                <Settings size={15} />
                <span>{providerConfigOpen ? "收起配置" : "配置 API"}</span>
              </button>
              {providerConfigOpen && providerSettings && (
                <ProviderConfigPanel
                  settings={providerSettings}
                  busy={Boolean(busy)}
                  onSaveOpenAI={handleSaveOpenAIConfig}
                  onClearOpenAI={handleClearOpenAIKey}
                  onSaveThirdParty={handleSaveThirdPartyConfig}
                  onSelectThirdParty={handleSelectThirdPartyConfig}
                  onClearThirdParty={handleClearThirdPartyKey}
                />
              )}
            </div>
            <div className="styleme-count">
              {[1, 2, 4].map((value) => (
                <button key={value} className={count === value ? "active" : ""} type="button" onClick={() => setCount(value)}>
                  {value}
                </button>
              ))}
            </div>
            {reference && !recipe && (
              <div className="styleme-step-warning">
                <Sparkles size={15} />
                <span>未分析原图。点击下方按钮会先分析，再开始生成。</span>
              </div>
            )}
            <button
              className="styleme-primary"
              data-testid="start-generation"
              type="button"
              disabled={Boolean(busy)}
              onClick={handleStartGeneration}
            >
              {busy === "开始生成" ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              <span>
                {busy === "开始生成"
                  ? `生成中 ${generationElapsedMs ? formatDuration(generationElapsedMs) : ""}`
                  : recipe
                    ? "开始生成"
                    : "先分析再生成"}
              </span>
            </button>
            {generationElapsedMs !== null && (
              <div className="styleme-timer">
                <Clock size={15} />
                <span>当前用时 {formatDuration(generationElapsedMs)}</span>
              </div>
            )}
            <details className="styleme-debug">
              <summary>
                <FlaskConical size={15} />
                <span>高级调试</span>
              </summary>
              <button className="styleme-secondary" type="button" disabled={Boolean(busy)} onClick={handleCreateDebugCodexJob}>
                {busy === "创建调试任务包" ? <Loader2 className="spin" size={16} /> : <FlaskConical size={16} />}
                <span>创建 Codex 任务包</span>
              </button>
            </details>
          </section>

          <section className="styleme-section">
            <div className="styleme-section-title">
              <BadgeCheck size={16} />
              <span>相册</span>
              <button className="styleme-mini" type="button" onClick={loadJobs} title="刷新相册">
                <RefreshCw size={14} />
              </button>
            </div>
            {activeJob ? (
              <>
                <JobCard
                  job={activeJob}
                  onRefresh={() => handleRefreshJob(activeJob)}
                  onRetry={() => handleRetryJob(activeJob.jobId)}
                  onFavorite={(output) => handleFavorite(activeJob.jobId, output)}
                  onDownload={(output) => handleDownload(activeJob, output)}
                  onDelete={(output) => handleDeleteOutput(activeJob.jobId, output)}
                  onDeleteJob={() => handleDeleteJob(activeJob)}
                  onPreview={(output) => setPreview({ job: activeJob, output })}
                  onMarkUsable={() => markJobUsable(activeJob)}
                />
                <JobHistoryList
                  jobs={jobs}
                  activeJobId={activeJob.jobId}
                  onSelect={(jobId) => setActiveJobId(jobId)}
                  onDelete={(job) => handleDeleteJob(job)}
                />
              </>
            ) : (
              <div className="styleme-empty">暂无任务</div>
            )}
          </section>
        </aside>
      )}

      {preview && (
        <ImagePreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
          onFavorite={() => handleFavorite(preview.job.jobId, preview.output)}
          onDownload={() => handleDownload(preview.job, preview.output)}
          onDelete={() => handleDeleteOutput(preview.job.jobId, preview.output)}
        />
      )}
    </>
  );
}

function ProviderConfigPanel(props: {
  settings: ProviderSettingsResponse;
  busy: boolean;
  onSaveOpenAI: (input: { apiKey?: string; model: string }) => Promise<void>;
  onClearOpenAI: () => Promise<void>;
  onSaveThirdParty: (
    key: ThirdPartyProviderKey,
    input: { apiKey?: string; baseUrl: string; model: string; analysisModel: string }
  ) => Promise<void>;
  onSelectThirdParty: (key: ThirdPartyProviderKey) => Promise<void>;
  onClearThirdParty: (key: ThirdPartyProviderKey) => Promise<void>;
}) {
  const openai = props.settings.providers.find((provider) => provider.mode === "openai-api");
  const activeThirdParty = props.settings.thirdPartyProviders.find((provider) => provider.active);
  const inactiveThirdParty = props.settings.thirdPartyProviders.filter((provider) => !provider.active);
  const [openaiModel, setOpenaiModel] = useState(openai?.model ?? "gpt-image-2");
  const [openaiKey, setOpenaiKey] = useState("");

  useEffect(() => {
    setOpenaiModel(openai?.model ?? "gpt-image-2");
    setOpenaiKey("");
  }, [openai?.model, openai?.keySource]);

  async function saveOpenAI() {
    await props.onSaveOpenAI({
      model: openaiModel,
      ...(openaiKey.trim() ? { apiKey: openaiKey.trim() } : {})
    });
    setOpenaiKey("");
  }

  return (
    <div className="styleme-provider-config">
      {activeThirdParty && (
        <ThirdPartyConfigForm
          provider={activeThirdParty}
          busy={props.busy}
          onSave={props.onSaveThirdParty}
          onSelect={props.onSelectThirdParty}
          onClear={props.onClearThirdParty}
        />
      )}

      <div className="styleme-provider-config-block">
        <div className="styleme-config-title">
          <strong>OpenAI</strong>
          <span>{openai?.configured ? `已配置 · ${keySourceLabel(openai.keySource)}` : "未配置 key"}</span>
        </div>
        <label>
          <span>模型</span>
          <input value={openaiModel} onChange={(event) => setOpenaiModel(event.target.value)} placeholder="gpt-image-2" />
        </label>
        <label>
          <span>API key</span>
          <input
            value={openaiKey}
            onChange={(event) => setOpenaiKey(event.target.value)}
            placeholder={openai?.configured ? "已保存，输入新 key 可替换" : "粘贴 OPENAI_API_KEY"}
            type="password"
          />
        </label>
        <div className="styleme-config-actions">
          <button type="button" disabled={props.busy} onClick={saveOpenAI}>
            保存 OpenAI
          </button>
          <button type="button" disabled={props.busy || openai?.keySource === "none"} onClick={props.onClearOpenAI}>
            清除 key
          </button>
        </div>
      </div>

      <div className="styleme-provider-config-list">
        {inactiveThirdParty.map((provider) => (
          <ThirdPartyConfigForm
            key={provider.key}
            provider={provider}
            busy={props.busy}
            onSave={props.onSaveThirdParty}
            onSelect={props.onSelectThirdParty}
            onClear={props.onClearThirdParty}
          />
        ))}
      </div>
    </div>
  );
}

function ThirdPartyConfigForm(props: {
  provider: ThirdPartyProviderSummary;
  busy: boolean;
  onSave: (
    key: ThirdPartyProviderKey,
    input: { apiKey?: string; baseUrl: string; model: string; analysisModel: string }
  ) => Promise<void>;
  onSelect: (key: ThirdPartyProviderKey) => Promise<void>;
  onClear: (key: ThirdPartyProviderKey) => Promise<void>;
}) {
  const { provider } = props;
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [analysisModel, setAnalysisModel] = useState(provider.analysisModel);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setBaseUrl(provider.baseUrl);
    setModel(provider.model);
    setAnalysisModel(provider.analysisModel);
    setApiKey("");
  }, [provider.baseUrl, provider.model, provider.analysisModel, provider.keySource]);

  async function save() {
    await props.onSave(provider.key, {
      baseUrl,
      model,
      analysisModel,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    });
    setApiKey("");
  }

  return (
    <div className="styleme-provider-config-block">
      <div className="styleme-config-title">
        <strong>{provider.label}</strong>
        <span>
          {provider.active ? "当前配置 · " : ""}
          {provider.configured ? `已配置 · ${keySourceLabel(provider.keySource)}` : "未配置 key"} · {provider.detail}
        </span>
      </div>
      <label>
        <span>baseUrl</span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
      </label>
      <label>
        <span>模型</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="image-model" />
      </label>
      <label>
        <span>看图分析模型</span>
        <input
          value={analysisModel}
          onChange={(event) => setAnalysisModel(event.target.value)}
          placeholder="支持图片输入的模型"
        />
      </label>
      <label>
        <span>API key</span>
        <input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={provider.configured ? "已保存，输入新 key 可替换" : "粘贴 API key"}
          type="password"
        />
      </label>
      <div className="styleme-config-actions">
        <button type="button" disabled={props.busy} onClick={save}>
          保存
        </button>
        <button type="button" disabled={props.busy || !provider.enabled} onClick={() => props.onSelect(provider.key)}>
          使用此 API
        </button>
        <button type="button" disabled={props.busy || provider.keySource === "none"} onClick={() => props.onClear(provider.key)}>
          清除 key
        </button>
      </div>
    </div>
  );
}

function JobHistoryList(props: {
  jobs: LocalGenerationJobManifest[];
  activeJobId: string;
  onSelect: (jobId: string) => void;
  onDelete: (job: LocalGenerationJobManifest) => void;
}) {
  if (props.jobs.length <= 1) return null;
  return (
    <div className="styleme-history">
      <div className="styleme-history-title">
        <strong>历史任务</strong>
        <span>{props.jobs.length} 个任务</span>
      </div>
      <div className="styleme-history-list">
        {props.jobs.map((job) => (
          <div key={job.jobId} className={job.jobId === props.activeJobId ? "active" : ""}>
            <button type="button" onClick={() => props.onSelect(job.jobId)} title="查看这个任务">
              <strong>{job.title}</strong>
              <span>
                {formatDateTime(job.createdAt)} · {providerLabel(job.providerMode)} · {job.outputs.length}/{job.count}
              </span>
            </button>
            <button
              className="styleme-mini danger"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                props.onDelete(job);
              }}
              title="隐藏整个任务"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobCard(props: {
  job: LocalGenerationJobManifest;
  onRefresh: () => void;
  onRetry: () => void;
  onFavorite: (output: LocalFileAsset) => void;
  onDownload: (output: LocalFileAsset) => void;
  onDelete: (output: LocalFileAsset) => void;
  onDeleteJob: () => void;
  onPreview: (output: LocalFileAsset) => void;
  onMarkUsable: () => void;
}) {
  const { job } = props;
  const canRetry =
    job.providerMode !== "codex-dev" &&
    (job.status === "failed" || job.status === "partial_succeeded" || job.status === "dead_letter");
  return (
    <div className="styleme-job">
      <div className="styleme-job-head">
        <div>
          <strong>{job.title}</strong>
          <span>{providerLabel(job.providerMode)} · {jobStatusLabel(job.status)}</span>
        </div>
        <div className="styleme-job-tools">
          <button className="styleme-mini" type="button" onClick={props.onRefresh} title="刷新结果">
            <RefreshCw size={14} />
          </button>
          <button
            className="styleme-mini danger"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onDeleteJob();
            }}
            title="隐藏整个任务"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <code>{job.rootDir}</code>
      {job.error && (
        <div className="styleme-job-error">
          <AlertTriangle size={14} />
          <span>{job.error}</span>
        </div>
      )}
      {job.outputs.length > 0 ? (
        <>
          <div className="styleme-gallery">
            {job.outputs.map((output) => (
              <figure key={output.id}>
                <button className="styleme-gallery-preview" type="button" onClick={() => props.onPreview(output)} title="查看大图">
                  <img src={absoluteLocalUrl(output.url ?? "")} alt={output.fileName} />
                  <span>查看大图</span>
                </button>
                <figcaption>
                  <button className={output.favorite ? "active" : ""} type="button" onClick={() => props.onFavorite(output)} title="收藏">
                    <Heart size={14} />
                  </button>
                  <button type="button" onClick={() => props.onDownload(output)} title="下载">
                    <Download size={14} />
                  </button>
                  <button className="danger" type="button" onClick={() => props.onDelete(output)} title="从插件相册隐藏">
                    <Trash2 size={14} />
                  </button>
                </figcaption>
                {job.durationMs !== undefined && (
                  <div className="styleme-output-meta">
                    <Clock size={13} />
                    <span>耗时 {formatDuration(job.durationMs)}</span>
                  </div>
                )}
              </figure>
            ))}
          </div>
          <button className="styleme-secondary" type="button" onClick={props.onMarkUsable}>
            <BadgeCheck size={16} />
            <span>标为可用</span>
          </button>
          {canRetry && (
            <button className="styleme-secondary" type="button" onClick={props.onRetry}>
              <RotateCcw size={16} />
              <span>重试</span>
            </button>
          )}
        </>
      ) : (
        <div className="styleme-empty">
          {job.providerMode === "codex-dev"
            ? "调试任务包已创建。需要手动用 input/ 图片和 generation-prompt.md 在 Codex 中生成。"
            : job.status === "failed"
              ? "未生成输出图，可重试或切换 Provider。"
              : "生成中或等待输出。"}
        </div>
      )}
      {canRetry && job.outputs.length === 0 && (
        <button className="styleme-secondary" type="button" onClick={props.onRetry}>
          <RotateCcw size={16} />
          <span>重试</span>
        </button>
      )}
    </div>
  );
}

function ImagePreviewModal(props: {
  preview: PreviewState;
  onClose: () => void;
  onFavorite: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { job, output } = props.preview;
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const isDragging = Boolean(dragStart);

  function updateZoom(nextZoom: number) {
    const clamped = clampNumber(nextZoom, 1, 4);
    setZoom(clamped);
    if (clamped === 1) setOffset({ x: 0, y: 0 });
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    updateZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    setOffset({
      x: dragStart.originX + event.clientX - dragStart.x,
      y: dragStart.originY + event.clientY - dragStart.y
    });
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStart?.pointerId === event.pointerId) {
      setDragStart(null);
    }
  }

  function handleDoubleClick() {
    updateZoom(zoom > 1 ? 1 : 2);
  }

  return (
    <div className="styleme-lightbox" role="dialog" aria-modal="true" aria-label="生成图预览" onClick={props.onClose}>
      <div className="styleme-lightbox-panel" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <strong>{output.fileName}</strong>
            <span>
              {providerLabel(job.providerMode)} · {jobStatusLabel(job.status)}
              {job.durationMs !== undefined ? ` · 耗时 ${formatDuration(job.durationMs)}` : ""}
            </span>
          </div>
          <button className="styleme-icon-button" type="button" onClick={props.onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div
          className={`styleme-lightbox-viewport ${zoom > 1 ? "zoomed" : ""} ${isDragging ? "dragging" : ""}`}
          onDoubleClick={handleDoubleClick}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onWheel={handleWheel}
        >
          <img
            src={absoluteLocalUrl(output.url ?? "")}
            alt={output.fileName}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`
            }}
            draggable={false}
          />
        </div>
        <footer>
          <code>{job.rootDir}</code>
          <div>
            <button type="button" onClick={() => updateZoom(zoom - 0.25)} title="缩小" aria-label="缩小">
              <ZoomOut size={15} />
            </button>
            <button type="button" onClick={() => updateZoom(1)} title="重置缩放" aria-label="重置缩放">
              <RotateCcw size={15} />
              <span>{Math.round(zoom * 100)}%</span>
            </button>
            <button type="button" onClick={() => updateZoom(zoom + 0.25)} title="放大" aria-label="放大">
              <ZoomIn size={15} />
            </button>
            <button className={output.favorite ? "active" : ""} type="button" onClick={props.onFavorite} title="收藏">
              <Heart size={15} />
              <span>收藏</span>
            </button>
            <button type="button" onClick={props.onDownload} title="下载">
              <Download size={15} />
              <span>下载</span>
            </button>
            <button className="danger" type="button" onClick={props.onDelete} title="从插件相册隐藏">
              <Trash2 size={15} />
              <span>隐藏</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function detectReferenceCandidate(target: EventTarget | null): ReferenceCandidate | null {
  if (!(target instanceof Element)) return null;
  const image = target.closest("img") as HTMLImageElement | null;
  if (image?.currentSrc || image?.src) {
    const sourceUrl = image.currentSrc || image.src;
    const rect = image.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    return {
      kind: "image",
      sourceUrl,
      previewUrl: sourceUrl,
      fileName: fileNameFromUrl(sourceUrl),
      altText: image.alt || image.title || document.title,
      rect
    };
  }

  let node: Element | null = target;
  for (let depth = 0; node && depth < 4; depth += 1) {
    const background = getComputedStyle(node).backgroundImage;
    const sourceUrl = parseCssUrl(background);
    const rect = node.getBoundingClientRect();
    if (sourceUrl && rect.width >= 60 && rect.height >= 60) {
      return {
        kind: "background",
        sourceUrl,
        previewUrl: sourceUrl,
        fileName: fileNameFromUrl(sourceUrl),
        altText: node.getAttribute("aria-label") || document.title,
        rect
      };
    }
    node = node.parentElement;
  }

  return null;
}

function parseCssUrl(value: string): string | undefined {
  const match = value.match(/url\(["']?(.+?)["']?\)/);
  if (!match?.[1]) return undefined;
  try {
    return new URL(match[1], location.href).href;
  } catch {
    return undefined;
  }
}

function toImagePayload(reference: ReferenceCandidate): ImagePayload {
  if (reference.dataUrl) {
    return { dataUrl: reference.dataUrl, fileName: reference.fileName };
  }
  return { sourceUrl: reference.sourceUrl, fileName: reference.fileName };
}

function buildSource(reference: ReferenceCandidate): ReferenceSource {
  return {
    altText: reference.altText,
    fileName: reference.fileName,
    pageTitle: document.title,
    pageUrl: location.href,
    sourceUrl: reference.sourceUrl
  };
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, location.href);
    const name = parsed.pathname.split("/").pop();
    return name || "reference.png";
  } catch {
    return "reference.png";
  }
}

function extensionFromFile(fileName: string): string {
  const match = fileName.match(/\.[a-z0-9]+$/i);
  return match?.[0] ?? ".png";
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) || "styleme";
}

function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /extension context invalidated|context invalidated/i.test(message);
}

function isRouteNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Route not found: POST .*\/delete-job/i.test(message);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}秒`;
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

function providerLabel(mode: ImageProviderMode): string {
  const labels: Record<ImageProviderMode, string> = {
    mock: "Mock 占位测试",
    "openai-api": "OpenAI",
    "codex-account": "Codex OAuth",
    "third-party": "第三方",
    "codex-dev": "Codex 调试"
  };
  return labels[mode];
}

function providerStatusLabel(status?: string): string {
  if (status === "available") return "可用";
  if (status === "needs_config") return "需配置";
  if (status === "experimental") return "实验";
  if (status === "unavailable") return "不可用";
  return "未知";
}

function keySourceLabel(source?: string): string {
  if (source === "env") return ".env";
  if (source === "local-settings") return "本地设置";
  return "未配置";
}

function thirdPartyLabel(key: ThirdPartyProviderKey): string {
  if (key === "geminiNanoBanana") return "Gemini Nano Banana";
  if (key === "openrouter") return "OpenRouter";
  return "自定义 API";
}

function jobStatusLabel(status: LocalGenerationJobManifest["status"]): string {
  const labels: Record<LocalGenerationJobManifest["status"], string> = {
    created: "已创建",
    queued: "排队中",
    "needs-manual-codex": "待手动 Codex",
    running: "生成中",
    succeeded: "已完成",
    partial_succeeded: "部分完成",
    failed: "失败",
    retrying: "重试中",
    dead_letter: "已停止"
  };
  return labels[status];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function selectViewportRect(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const box = document.createElement("div");
    const hint = document.createElement("div");

    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "rgba(15, 23, 42, 0.22)",
      userSelect: "none"
    });

    Object.assign(box.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      border: "2px solid #f5c542",
      background: "rgba(255, 248, 215, 0.18)",
      boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.12)",
      pointerEvents: "none",
      boxSizing: "border-box"
    });

    hint.textContent = "拖拽选择参考图区域，按 Esc 取消";
    Object.assign(hint.style, {
      position: "fixed",
      left: "50%",
      top: "18px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "8px 12px",
      borderRadius: "8px",
      background: "#17212b",
      color: "#fff",
      font: "700 13px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      letterSpacing: "0",
      pointerEvents: "none"
    });

    overlay.append(hint);
    overlay.append(box);
    document.documentElement.append(overlay);

    let startX = 0;
    let startY = 0;
    let active = false;

    const cleanup = () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      overlay.remove();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cleanup();
      resolve(null);
    };
    document.addEventListener("keydown", handleKeyDown, true);

    overlay.addEventListener("mousedown", (event) => {
      active = true;
      startX = event.clientX;
      startY = event.clientY;
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = "0px";
      box.style.height = "0px";
      event.preventDefault();
    });

    overlay.addEventListener("mousemove", (event) => {
      if (!active) return;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const width = Math.abs(event.clientX - startX);
      const height = Math.abs(event.clientY - startY);
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    });

    overlay.addEventListener("mouseup", (event) => {
      if (!active) {
        cleanup();
        resolve(null);
        return;
      }
      active = false;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const width = Math.abs(event.clientX - startX);
      const height = Math.abs(event.clientY - startY);
      cleanup();
      resolve(width >= 20 && height >= 20 ? { x, y, width, height } : null);
    });
  });
}
