# 喵团 CatTuan

通用个人助理（Personal Agent）：查资料、深度调研、搜图识图、替你打电话，用「目标」持续替你关注事情。仿 Muse 的「主 agent + 子 agent + Goal」架构，LongCat 驱动，界面用 LongCat 品牌图标和绿色配色。

```
用户 ──► 主 agent（app/dispatcher.mjs，每个聊天一个 Pi 会话，在 App 进程里跑）
          │  聊天口吻短回复；一两步能办完的自己办（搜索 / 读网页 / 搜图 / 看图 / 记忆 / 技能，不打电话）；
          │  复杂的事（打电话、深度调研、要好几分钟的）用 subagent 工具派子 agent；改 / 停子 agent、出提问卡、建目标；连发的消息并进同一轮
          │
目标调度器（每 30 秒看一次到期目标）──► 派「目标检查」任务 ──► 有新进展才在聊天里说，目标列表显示最新状态
          ▼
        后台任务队列（不限并发，派出就跑；状态经 SSE 推到「任务」Tab）
          │
          ▼
        子 agent（Pi SDK gateway :8650）：派出时复制主 agent 的会话，工具和主 agent 一样，外加打电话
          │  deep_web_search / read_webpage ──► 沙箱浏览器（sandbox :8660，独立 profile 的无头 Chromium）
          │  idol_photo_search ──► 必应图片搜索
          ▼
        结果 ──► 送回主 agent 的会话，由它接着说（默认 1–2 句；有重要信息才多说）+ 图墙 / 报告卡片 / 通话组件
```

```
app/            主 agent + 任务队列 + 目标调度 + Web App（聊天 / 目标 / 任务三个 Tab）+ 图片代理 + 登录页
  accounts.mjs            账号（名字 + 密码）：用户、登录会话、每日用量，存 app/data/app.db（node:sqlite）
  dispatcher.mjs          主 agent：每个聊天一个 Pi 会话（chat-<聊天 id>），连发合并、子 agent 结果回到同一会话；干活的工具同 pi-tools.mjs，聊天专用工具在 dispatcher-tools.mjs
  pi-gateway.mjs          基于 Pi SDK 的任务执行入口，兼容 /v1/runs、SSE、停止和插话
  homes.mjs               账号独立的数据目录、端口与凭据
  tools/                  原生 Node 业务工具：通话、搜索、读网页、搜图、记忆、技能、识图
  data/users/<id>/        每个人的聊天、任务、目标、上传的图、回放与 agent-home/
sandbox/        沙箱浏览器：网页搜索和读网页（只读）；profile 在 sandbox/profile/
deploy/         部署：setup.sh 一键安装 / 更新（systemd、Caddy、每日备份），见 deploy/README.md
agent-home/     执行 agent 的模板目录；管理员也可沿用此处的本地数据
  SOUL.md                 执行 agent 的人设与工具使用说明
  config.yaml             工具、技能和记忆的开关
  skills/cattuan/         项目自带技能（深度搜索、打电话、本地生活）
  memories/               长期记忆和用户资料
  pi/sessions/            Pi 的持久化任务会话
scripts/        start.sh 一键启动；restart.sh 等没有进行中的任务再重启（重启前没跑完的任务也会自动续跑）（start-sandbox.sh / start-app.sh 可单独启动）
  user.mjs                账号管理：add 建号 / passwd 改密码 / list / disable / enable / adopt（从单用户版升级）
  agents.mjs              agent 守护进程：给每个账号跑一个 Pi gateway（start-agent.sh <主目录>），挂了自动拉起，停用的账号停掉
```

## 启动

第一次（需要 Node 22.19+、Chrome 或 Playwright 的 Chromium）：

```bash
git clone <仓库地址> CatTuan && cd CatTuan
cd app && npm ci --omit=dev && cd ..                              # 安装 Pi SDK（锁定 @earendil-works/pi-coding-agent 1.3.0）
cd sandbox && npm ci --omit=dev && cd ..                                # 装 playwright-core（复用本机 Playwright 缓存的 Chromium）
cp agent-home/.env.example agent-home/.env                      # 填上自己的 LONGCAT_API_KEY
node scripts/user.mjs add <你的名字> --admin                       # 建管理员账号，按提示设密码
```

从单用户版升级（原来的聊天、记忆都留着）：先停掉 App 和 agent，再跑一次 `node scripts/user.mjs adopt <你的名字>`。它把 `app/data/state.json`、上传的图、回放归到这个账号下，agent 沿用仓库的 `agent-home`，最后打印设密码的链接。

以后每次：

```bash
scripts/start.sh                     # sandbox :8660 + 每个账号一个 agent（沿用老数据的 :8650，新账号 :8701 起）+ app http://localhost:3210
```

- `LONGCAT_API_KEY`：读取 `agent-home/.env`，所有账号的 agent 共用。每个账号 agent 自己的端口和 key（`API_SERVER_*`）在它主目录的 `.env` 里，建账号时生成。
- Pi 执行模型可用 `.env` 的 `PI_MODEL`、`PI_API_URL`、`PI_API_KEY` 覆盖，默认仍是 LongCat。`PI_MAX_TOKENS` 默认 8192，`PI_CONTEXT_WINDOW` 默认 128000，`PI_MAX_TURNS` 默认 90；达到限制会明确标记任务失败。`config.yaml` 继续管理业务工具、技能和记忆开关，调度模型仍由 `DISPATCH_MODEL` 配置。
- 仓库里只有代码和配置。运行时数据都在本机、不进仓库（见 `.gitignore`）：账号库和每个人的数据 `app/data/`（聊天记录、agent 的 Pi 会话、记忆、自动装的技能），以及沙箱浏览器的 profile `sandbox/profile/`。
- 沙箱浏览器使用 `agent-home/.env` 里的 `HTTP(S)_PROXY` 访问国外网站（也可以单独设 `SANDBOX_PROXY`），国内站点始终直连。

## 测试

测试：`cd app && npm test`。只使用临时数据和本地模拟服务；不会拨打真实电话或改动用户数据。

## 多人使用（账号）

小范围给同事用，部署到服务器见 [deploy/README.md](deploy/README.md)。

- **账号**：名字 + 密码登录，分管理员和成员。管理员用 `node scripts/user.mjs add 小王` 建号并设密码（`--admin` 建管理员），`passwd 小王` 改密码（旧密码和所有登录作废）；`disable` 立刻下线、停掉他的 agent，数据保留。调试用的 `POST /api/auth/register` 可以注册成员账号并直接登录：本机（`PUBLIC_ORIGIN` 不是 https）默认开，线上默认关，设 `ALLOW_REGISTER=1` 打开、`ALLOW_REGISTER=0` 关掉；同一 IP 15 分钟最多注册 10 个。密码用 scrypt 加盐，登录会话的 token 在库里只存哈希。
- **鉴权**：网页用 HttpOnly cookie。原生 App 登录时在请求体里加 `"token": true`（`/api/auth/login`、`/api/auth/register` 都支持），响应里返回 `token`、不下发 cookie，之后每个请求（包括 SSE `/api/events`、图片 `/api/uploads/…`）带 `Authorization: Bearer <token>`。两种是同一张会话表：30 天有效、用着自动续期，`/api/auth/logout`、`disable`、重置密码都会让它作废。
- **隔离**：每个人的聊天、任务、目标、上传的图、回放分开存，实时推送（SSE）只推给本人，拿别人的 id 调接口一律 404。
- **执行 agent 每人一个**：每人一个 Pi gateway 和独立数据主目录，记忆、Pi 会话分开。业务工具直接在 Node 进程内运行，以 `CATTUAN_HOME` / `PI_HOME` 定位数据，无额外 agent 框架或 Python 环境。
- **沙箱浏览器大家共用**：实时画面按任务编号（工具从任务会话 id 取）只推给任务的主人；猜不准是谁的就不显示。
- **角色**：管理员（`--admin`）不受额度限制。成员每天有消息、后台任务、目标检查的额度，最多同时盯 5 个目标、最短 60 分钟查一次；后台任务全局最多 4 个、每人最多 2 个同时跑，按先来后到轮流。都可以在环境变量里调，线上在 `/etc/cattuan.env`（见 [deploy/README.md](deploy/README.md)）。
- **上线配置**：`PUBLIC_ORIGIN`（App 的 https 地址：来源校验、cookie 的 Secure / `__Host-` 前缀都按它来）。本机开发不用设。

## 交互

- **聊天**：主 agent 在想、在搜、在转述时，顶栏标题下面的状态实时显示它正在做的那一步（「想想怎么回…」「上网搜「…」…」「组织回答…」「转述「…」的结果」），同时几件事会带件数；没事时显示后台任务数或「在线」。喵团在想上一条时也能接着发：新消息并进正在想的那一轮（Pi 插话），几条合起来回、只办一次事。派了后台任务时，聊天页右下角的小电视直播它在干什么；任务完成后，结果作为新消息发回，并标注「来自后台任务」。
- **输入区**（仿微信）：输入框右边是「+」，有内容时变成「发送」。点「+」弹出工具面板：相册、拍摄。
- **技能**（用户不用设置）：执行 agent 需要什么技能就自己装。遇到现有工具和技能做不好的事，它会用 `skill_store` 在本地技能和在线技能库（skills.sh 等）里找，然后安装。在线技能安装前会校验来源、路径和内容，拒绝可执行载荷与危险指令；装的原因记在 `agent-home/skills/.cattuan_installs.json`。很多技能要读网页，所以执行 agent 有只读的 `fetch_url`（只能 GET 公开网址，内网和本机地址会被拦截，限大小）。
- **目标**：持续目标，定时让执行 agent 检查（每 N 分钟或每天几点）。每个目标下面一行小字显示最新状态和更新时间；只有执行 agent 判断「有新进展」才在聊天里主动发消息，标「🎯 来自目标」；已推过的图不会重复推。可以在目标页用一句话添加，也可以在聊天里说「以后每天早上 8 点告诉我天气」「机票降到 800 以下提醒我」。支持立即检查、暂停、删除。仿 Muse：卡片左边的勾选框是「完成」（不再检查，挪到「已完成」，再点一下接着盯）；在聊天里说「那个不用盯了」也会完成；执行 agent 检查时判断事情已经彻底办完（`DONE: yes`，比如一次性提醒已发出）会自动完成。点卡片展开详情：目标说明、动态时间线（建好、每次检查的结论、暂停 / 继续、完成）和下次检查时间。
- **深度搜索**：遇到要全面查清楚、调研、对比、找途径的问题，主 agent 会派「深度搜索」子 agent。子 agent 按 `skills/cattuan/deep-research` 的方法做：用 `deep_web_search` 换角度搜几轮（在沙箱真实浏览器里搜必应），用 `read_webpage` 读原文，再交叉核对，最后写一份带 [n] 引用的报告。聊天里显示为「研究报告」卡片，引用可点、有来源列表；任务卡片里有「深度搜索过程」（每次搜了什么、读了哪些网页、读到没有）和浏览器回放。读网页只读：不下载文件、不访问内网，国内站点直连。不找盗版：要免费下载付费内容时，改为找图书馆数字资源、官方免费内容和正版优惠。
- **浏览器实时画面**（仿 Claude Cowork）：执行 agent 用沙箱浏览器搜网页、读网页时，任务卡片里会出现一个小浏览器窗口，有地址栏、实时画面（每秒最多 4 帧）和当前在做的一步，比如「在必应搜索「…」」「打开并阅读 …」。聊天里派任务那条回复下面也会挂一个小的实时画面。做完后保留最多 16 张关键帧做「回放」，加上完整的浏览过程。画面来自沙箱的 `/live`（CDP screencast 加每步截图），App 服务转发并把关键帧存到 `app/data/frames/`。只有 App 开着时才推连续画面（这时沙箱也会加载图片）；没人看时只记步骤和关键帧。
- **任务**：看所有后台任务（对话任务和目标检查）的状态、执行步骤、用时、任务说明（主 agent 交给子 agent 的 task）、执行结果。进行中、排队中的任务卡片上有「停止」按钮。
- **改任务 / 停止**：对一个排队中、进行中或刚做完的任务说「不要…」「换成…」「再加上…」「这个不好」，主 agent 会调 `steer_task` 改那个任务，不另开新任务；说「别弄了」就调 `stop_task`。App 按任务阶段处理：排队中 → 并进任务说明；进行中 → 用 Pi gateway 的 `/v1/runs/{id}/steer` 插话，agent 在下一步之前看到新要求，已经做的不丢；插话没赶上这一轮（`pending_steer`）→ 这一轮的结果先不发，在同一个会话里接着改一轮；已完成 / 失败 / 已停止 → 在同一个 Pi 会话（`task-<任务 id>`）里接着跑「第 N 轮修改」，agent 记得前面做过什么，结果更新在原任务上。任务卡片里有「修改记录」（每条要求的去向）和「第 N 轮」标记。后台任务用 `/v1/runs` 跑（POST 开始、`/events` 收事件、`/stop` 停止），App 重启时按 run id 接回还在跑的那一轮；Pi gateway 将工具执行事件连同参数、结果转成 App 现有事件格式，搜图结果、深度搜索过程继续显示。用户发的图片以本地路径交给主 agent，由它用 `vision_analyze` 看；子 agent 复制了会话，也看得到这些路径。

## 已知限制

- 沙箱和 App 用 JS 截字符串时可能把 emoji 切成半个；发送给模型或业务工具前会清理不完整的字符。
- 主 agent 是 App 进程里的 Pi agent：会话存在 `<数据目录>/users/<id>/pi-chat/`（删聊天时一起删），Pi 自动压缩长对话。模型用 `DISPATCH_MODEL`（要能看图），可用 `DISPATCH_API_URL`、`DISPATCH_MAX_TURNS`（默认 10）、`DISPATCH_MAX_TOKENS`（默认 1024）调。干活的工具和子 agent 是同一套（`pi-tools.mjs`，按这个人的工具开关），只是不打电话：打电话要 1–5 分钟，这段时间主 agent 回不了消息，所以交给子 agent。升级前的老聊天第一次走主 agent 时，会带上最近 15 条消息接上下文。
- 子 agent：主 agent 调 `subagent` 时，App 当场把这个聊天的 Pi 会话复制一份（`SessionManager.forkFrom`）到 gateway 的 `task-<任务 id>` 会话目录，子 agent 接着这段对话做事，task 里不用复述聊天。之后的修改轮仍在这个会话里接着跑。目标检查和自动重拨不复制会话，照旧只凭任务说明做。

- 必应搜图的补充结果质量一般，靠屏蔽站点名单加 LLM 挑图来过滤。
- 一个找图任务约 20–70 秒；调度者首条回复约 3–5 秒（要先上网搜的约 10 秒）；结果转述约 4 秒。
- 多人时沙箱浏览器是串行的（深度搜索也走它），人多会排队。改了 `agent-home/config.yaml` 以后，新账号自动用新的，已有账号的 config.yaml 要手动同步（技能商店会改各人那份）。
