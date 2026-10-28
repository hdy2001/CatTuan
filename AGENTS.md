# CatTuan 仓库开发指引

本文件面向在此仓库工作的所有编码 agent（Codex、Claude Code 等）。默认用中文沟通；先阅读相关代码，再修改并验证。产品说明见 `README.md`，部署说明见 `deploy/README.md`。

## 项目与架构

喵团 CatTuan 是个人助理 Web App，提供聊天、后台任务、持续目标、搜索、搜图识图和通话能力。

- 技术栈：Node.js >= 22.19、JavaScript ESM（`.mjs`）、原生 HTML/CSS/JS、`node:sqlite`、Playwright。`app/` 与 `sandbox/` 各自管理 npm 依赖和锁文件，根目录没有 npm 包。
- 运行时：`app/agent/runtime.mjs` 用 Pi SDK 管理模型循环与持久化会话，一个账号一个 runtime（`app/agent/agents.mjs`），按 profile 区分主 agent（`main`）和子 agent（`worker`）；都在 App 进程里跑。
- 主 agent：`app/agent/main.mjs` 每个聊天一个会话 `chat-<聊天 id>`，自己干活（和子 agent 同一套业务工具，不含打电话），复杂的事用 `subagent` 工具派子 agent；聊天专用工具在 `app/agent/main-tools.mjs`，每轮读到的状态块在 `app/agent/context.mjs`。
- 子 agent：派出时把主 agent 会话复制成 `task-<任务 id>`，由 `app/agent/worker.mjs` 跑，工具和主 agent 一样，外加打电话。任务的排队、轮次、插话、停止、重启续跑在 `app/core/tasks.mjs`；目标在 `app/core/goals.mjs`。
- 工具层：`app/agent/tools.mjs` 注册工具、应用 `config.yaml` 开关并传递取消信号和进度回调；`app/tools/` 下实现业务能力（`web`、`knowledge`、`business`、`output`），`common.mjs` 提供文件锁、原子写入和配置读写。打电话在 `app/calls/`：通话记录（`calls.mjs`）、木星外呼 CLI（`jupiter-provider.mjs`，拨号用 `call aicall`、结果查话单）和它的鉴权（`cli-auth.mjs`）。
- App 层：`app/server.mjs` 只组装模块；`app/http/` 是登录、接口路由、上传和图片代理；`app/core/` 是每个人的状态、聊天、额度、浏览器实时画面。
- 账号层：`app/accounts.mjs` 管理账号和登录；`app/homes.mjs` 解析每个用户的数据目录和 agent 主目录。
- 前端：`app/public/` 直接提供静态资源（原生 ES 模块，入口 `app.js`，界面各块在 `ui/`），无前端构建步骤。沿用现有交互、移动端适配与视觉样式。
- 浏览器服务：`sandbox/server.mjs` 用无头浏览器提供网页搜索、读网页和实时画面回放。
- agent 的人设和做事规矩在 `agent-home/SOUL.md`（共用）、`MAIN.md`（主 agent）、`WORKER.md`（子 agent），业务技能在 `agent-home/skills/cattuan/`。本文件是开发指引，不代替产品 agent 的人设。

## 技术方向与接口约束

- 执行 runtime 使用 Pi，业务工具原生运行于 Node；保持单一执行框架，直接注册项目业务工具。
- Pi 仅使用项目显式注册的业务工具。保持当前资源隔离，不自动加载宿主机全局扩展、任意 shell 工具或开发仓库指令。
- 代码只放通用机制，场景上的做法写在提示词和技能里：怎么说话、什么时候派子 agent、某类事要问清哪些信息、结果怎么转述，改 `agent-home/*.md` 和 `skills/cattuan/`，不要在 JS 里按工具名、任务种类或文本标记写特判。
  - 工具自带 `label` 和 `describe(args) → { act, detail, done(out) }`（任务轨迹和顶栏怎么写这一步）、`usesBrowser`；进行中的状态用 `onUpdate`（事件 `tool.updated`，存在步骤的 `progress` 上）。
  - 给用户看的东西走 `attachments: [{ type, … }]`（`images`、`document`、`ask`、`calls`）：工具在结果里返回 `attachments`（只给 App，不进模型的文字），或者 agent 调 `attach`。前端按 `type` 画。
  - 目标检查用 `goal_update` 报告 `{ status, notify, done }`；结构化结果不要再让模型写文本标记再用正则解析。
- 修改执行链路时保持这些约定：会话 id `chat-<聊天 id>` / `task-<任务 id>`；run 的事件（`message.completed`、`tool.started/updated/completed`、`run.completed/failed/cancelled`）；插话没赶上时的 `pending_steer`；停止；同一任务在同一会话里续跑和开新一轮；App 重启后进行中的任务在原会话里接着做。
- 工具按当前用户的 home、配置和凭据执行；尊重工具、技能、记忆开关。网络操作应有超时、响应大小限制并支持取消。
- 新增持久化写入复用 `common.mjs` 的原子写入；多个任务（或 App 和 scripts/）可能同时改同一个业务文件时使用相同的文件锁约定，并在锁内重读。
- 更新依赖时同步对应 `package-lock.json`；以实际安装版本的 API 为准，避免无关升级或大规模重排代码。

## 数据与隔离

- `app/data/app.db` 保存账号；`app/data/users/<id>/` 保存每个用户的业务数据。通过 `homeOf(user)` 等现有方法定位 home，兼容管理员沿用根目录 `agent-home/` 的情况。
- `agent-home/` 同时可能含模板和真实运行数据。不可把整个目录当作可删除的缓存，也不可整体加入 Git。
- 密钥、`.env`、聊天记录、记忆、Pi 会话、上传图片、浏览器 profile 和内部资料均不得写入提交、测试快照或公开日志。新增数据路径时同步 `.gitignore`，提交前核对实际暂存文件。
- 迁移前确认任务空闲并停止写入数据的服务，保留可恢复备份；迁移应可重复执行，不覆盖已有目标目录、不丢失用户资料。
- 保持每个账号的 API 鉴权、数据访问、任务事件与回放隔离。工具只拿当前用户的 home、上传目录和任务编号；不要广播 SSE，也不要信任客户端提供的用户 id。
- 保持 App 写接口的来源校验。公开 URL 抓取须校验重定向和解析地址，禁止访问内网。
- 测试使用临时目录和模拟服务（外呼用 `app/calls/fake-cli.mjs` 的假 CLI）；普通验证不要拨打真实电话、创建真实预约或修改真实用户数据。

## 常用命令

以下命令在仓库根目录运行。安装前先检查已有依赖，不覆盖现有 `.env`。

```bash
# 安装各服务依赖
npm ci --prefix app
npm ci --prefix sandbox

# 首次配置：仅在 agent-home/.env 不存在时复制并填写模型凭据
test -f agent-home/.env || cp agent-home/.env.example agent-home/.env
# 首次建管理员；已有账号的环境无需重复执行
node scripts/user.mjs add <名字> --admin

# 前台启动全部服务，Ctrl+C 停止
scripts/start.sh

# 已在运行时，等待后台任务空闲再重启指定服务
scripts/restart.sh app
scripts/restart.sh sandbox
# scripts/restart.sh all [最长等待秒数，默认 600]

# 老数据转新格式（先停 App；可重复执行，先备份到 app/data/backups/；--dry-run 只看不改）
node scripts/migrate.mjs

# App 测试（Node 内置 test runner）
npm test --prefix app
# 按改动选择指定测试：runtime / 主 agent / 端到端
node --test app/agent/runtime.test.mjs app/agent/control.test.mjs app/agent/integration.test.mjs
node --test app/agent/main.test.mjs app/e2e.test.mjs

# 服务检查
curl --fail --silent --show-error http://127.0.0.1:3210/api/health
```

- 默认 App 地址 `http://localhost:3210`，浏览器服务 `:8660`。
- App 健康响应的 `executorRuntime` 应为 `pi`。健康响应只证明服务状态，不能替代实际任务链路测试。
- 关键配置都在 `app/config.mjs` 里读：`LONGCAT_API_KEY`；子 agent 的 `PI_MODEL`、`PI_API_URL`、`PI_API_KEY`、`PI_MAX_TURNS`；主 agent 的 `DISPATCH_MODEL`、`DISPATCH_API_URL`、`DISPATCH_MAX_TURNS`；`CATTUAN_DATA_DIR`、`CATTUAN_SANDBOX_URL`。示例见 `agent-home/.env.example`；线上配置是 `deploy/setup.sh` 生成的 `/etc/cattuan.env`。
- 本地日志通常为 `app/data/server.out`、`sandbox/server.out`，App 数据目录可由 `CATTUAN_DATA_DIR` 覆盖；查看时注意隐藏凭据和用户内容。

## 修改与验收

- 保留已有未提交修改，不要擅自清理其他工作的分支、文件或改动。
- 遵循现有代码风格。小改动保持范围集中；接口、配置或运行方式变更同步 README 和相关部署说明。
- 运行与改动相关的测试。运行时、工具、鉴权、迁移等重要改动应验证成功路径与失败路径；不通过删除断言、隐藏异常或跳过失败用例来获得通过结果。
- 执行链路重点检查：真实 Pi SDK 到模拟模型和工具的往返、会话复制和恢复、App 重启续跑、停止/插话、工具禁用，以及用户数据隔离（`app/e2e.test.mjs` 覆盖了主要路径）。
- Shell 改动用 `bash -n <脚本>` 检查；前端交互改动检查实际页面和窄屏表现。当前没有统一 lint/build 命令，不编造已执行的检查。
- 完成后简要说明改了什么、实际验证结果及尚未解决的问题。仅文档改动可核对内容与路径，不必启动服务；未经验证不宣称服务已运行或迁移已完成。

本文件采用仓库级 `AGENTS.md` 约定（[agents.md](https://agents.md)），各家 agent 通用；不另写 agent 专属的说明文件，需要补充的约定直接写在这里。
