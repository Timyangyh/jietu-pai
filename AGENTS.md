# AGENTS.md

## 目标

这是本地优先的 Chrome 插件工具。插件负责网页选图、截图和 UI；本地服务负责 Provider 配置、生成任务、文件读写和相册。

## 执行顺序

1. 先读 `README.md`。
2. 安装依赖：`pnpm install`。
3. 构建插件：`pnpm build:extension`。
4. 启动服务：`pnpm start:server`。
5. Chrome 加载根目录 `照样拍插件-本地加载版/`。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build:extension
pnpm smoke:server
```

UI 自动验证只在需要排查界面时运行：

```bash
pnpm exec playwright install chromium
pnpm verify:ui
```

## 边界

- 不读取、复制、上传 `.env`、API key、OAuth token、cookie 或 `runs/` 历史图片。
- 不把 key 写进插件包、前端日志或 Git。
- 不提交依赖、缓存、构建产物、本地运行数据或插件 zip。
- 保留本地优先架构：Chrome 插件 + 本地服务 + Provider Adapter。
- 不新增登录、支付、数据库、队列、对象存储或 Web 管理台，除非用户明确要求。

## Git 操作

提交前必须先检查：

```bash
git status --short --ignored
```

禁止 `git add .`。只添加必要源码、文档和锁文件。不要提交：

```text
node_modules/
.wxt/
.output/
dist/
build/
coverage/
test-results/
playwright-report/
runs/
.tmp/
release-assets/
*.log
*.zip
.env
.env.*
```
