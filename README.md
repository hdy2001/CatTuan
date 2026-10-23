# 喵团 CatTuan

通用个人助理（Personal Agent）：查资料、深度调研、做网页、找附近好去处、读社媒公开账号、记账，用「目标」持续替你关注事情。仿 Muse 的「调度者 + 后台执行 agent + Goal」架构，LongCat 驱动，界面用 LongCat 品牌图标和绿色配色。

```
用户 ──► 调度者（app/server.mjs，直连 LongCat，不带工具）
          │  几秒内用聊天口吻短回复；记账直接写账本；想长期关注的事建成目标；需要干活就派后台任务
          │
目标调度器（每 30 秒看一次到期目标）──► 派「目标检查」任务 ──► 有新进展才在聊天里说，目标列表显示最新状态
          ▼
        后台任务队列（最多 2 个并行，状态经 SSE 推到「任务」Tab）
          │
          ▼
        执行 agent（Pi SDK gateway :8650，工具：搜索 / 社媒账号 / 做网页 / 搜图 / 识图 / 记忆 / 记账 / 技能）
          │  official_account / official_photos ──► 沙箱浏览器（sandbox :8660，独立 profile 的无头 Chromium）
          │        ──► 微博（访客）/ B 站（免登录）/ X、Instagram、Weverse（用户在沙箱窗口里自己登录）
          │  idol_photo_search ──► 必应图片搜索
          ▼
        结果 ──► 调度者转成聊天消息（默认 1–2 句；有重要信息才多说）+ 图墙
```

```
app/            调度者 + 任务队列 + 目标调度 + Web App（聊天 / 目标 / 任务三个 Tab）+ 图片代理 + 登录页
  accounts.mjs            账号（只能邀请）：用户、登录会话、邀请链接、每日用量，存 app/data/app.db（node:sqlite）
  pi-gateway.mjs          基于 Pi SDK 的任务执行入口，兼容 /v1/runs、SSE、停止和插话
  homes.mjs               账号独立的数据目录、端口与凭据
  tools/                  原生 Node 业务工具：记账、网站、通话、搜索、社媒、记忆、技能、识图
  data/users/<id>/        每个人的聊天、任务、目标、上传的图、回放与 agent-home/
sandbox/        沙箱浏览器：只读访问社媒公开账号、网页搜索和读网页；登录态在 sandbox/profile/
deploy/         部署：systemd、Caddy、每日备份，见 deploy/README.md
agent-home/     执行 agent 的模板目录；管理员也可沿用此处的本地数据
  SOUL.md                 执行 agent 的人设与工具使用说明
  config.yaml             工具、技能和记忆的开关
  skills/cattuan/         项目自带技能（深度搜索、网页、记账等）
  ledger/                 账本与记账记忆
  memories/               长期记忆和用户资料
  pi/sessions/            Pi 的持久化任务会话
  official_accounts.json  已关注的社媒账号
langfuse/       调试用的轨迹分析：本机自托管 Langfuse 的 docker-compose.yml（见下面「调试：轨迹分析」）
scripts/        start.sh 一键启动；restart.sh 等没有进行中的任务再重启（重启前没跑完的任务也会自动续跑）（start-sandbox.sh / start-app.sh 可单独启动）；start-langfuse.sh 启动 Langfuse
  user.mjs                账号管理：invite 发邀请链接 / list / disable / enable / adopt（从单用户版升级）
  agents.mjs              agent 守护进程：给每个账号跑一个 Pi gateway（start-agent.sh <主目录>），挂了自动拉起，停用的账号停掉
```

## 启动

第一次（需要 Node 22.19+、Chrome 或 Playwright 的 Chromium）：

```bash
git clone <仓库地址> CatTuan && cd CatTuan
cd app && npm ci --omit=dev && cd ..                              # 安装 Pi SDK（锁定 @earendil-works/pi-coding-agent 1.3.0）
cd sandbox && npm ci --omit=dev && cd ..                                # 装 playwright-core（复用本机 Playwright 缓存的 Chromium）
cp agent-home/.env.example agent-home/.env                      # 填上自己的 LONGCAT_API_KEY
node scripts/user.mjs invite <你的名字> --admin                    # 建管理员账号，打开打印的链接设密码
```

从单用户版升级（原来的聊天、账本、记忆都留着）：先停掉 App 和 agent，再跑一次 `node scripts/user.mjs adopt <你的名字>`。它把 `app/data/state.json`、上传的图、回放归到这个账号下，agent 沿用仓库的 `agent-home`，最后打印设密码的链接。

以后每次：

```bash
scripts/start.sh                     # sandbox :8660 + 每个账号一个 agent（沿用老数据的 :8650，新账号 :8701 起）+ app http://localhost:3210
```

- `LONGCAT_API_KEY`：读取 `agent-home/.env`，所有账号的 agent 共用。每个账号 agent 自己的端口和 key（`API_SERVER_*`）在它主目录的 `.env` 里，建账号时生成。
- Pi 执行模型可用 `.env` 的 `PI_MODEL`、`PI_API_URL`、`PI_API_KEY` 覆盖，默认仍是 LongCat。`PI_MAX_TOKENS` 默认 8192，`PI_CONTEXT_WINDOW` 默认 128000，`PI_MAX_TURNS` 默认 90；达到限制会明确标记任务失败。`config.yaml` 继续管理业务工具、技能和记忆开关，调度模型仍由 `DISPATCH_MODEL` 配置。
- 仓库里只有代码和配置。运行时数据都在本机、不进仓库（见 `.gitignore`）：账号库和每个人的数据 `app/data/`（聊天记录、agent 的 Pi 会话、记忆、账本、关注列表、生成的网站、自动装的技能），以及沙箱浏览器的登录态 `sandbox/profile/`。
- 图片代理使用 `agent-home/.env` 里的 `HTTP(S)_PROXY`，取 twimg、cdninstagram 等国内直连不了的图床；各平台图床（sinaimg、hdslb、twimg、cdninstagram / fbcdn、wevpstatic）会自动补 Referer。
- 沙箱浏览器同样沿用这个代理访问 X / Instagram / Weverse（也可以单独设 `SANDBOX_PROXY`），微博、B 站始终直连。

## 测试

测试：`cd app && npm test`。只使用临时数据和本地模拟服务；不会拨打真实电话或改动用户账本。

## 多人使用（账号）

小范围给同事用，部署到服务器见 [deploy/README.md](deploy/README.md)。

- **账号**：只能邀请，不开放注册。管理员 `node scripts/user.mjs invite 小王` 发一个 7 天有效、只能用一次的链接，同事打开后自己设密码。再发一次等于重置密码；`disable` 立刻下线、停掉他的 agent，数据保留。密码用 scrypt 加盐，登录会话的 token 在库里只存哈希。
- **隔离**：每个人的聊天、任务、目标、位置、上传的图、回放分开存，实时推送（SSE）只推给本人，拿别人的 id 调接口一律 404。
- **执行 agent 每人一个**：每人一个 Pi gateway 和独立数据主目录，记忆、账本、关注、网站、Pi 会话分开。业务工具直接在 Node 进程内运行，以 `CATTUAN_HOME` / `PI_HOME` 定位数据，无额外 agent 框架或 Python 环境。
- **沙箱浏览器大家共用**：平台账号由管理员登录，成员看得到登录状态、没有登录按钮。实时画面按任务编号（工具从任务会话 id 取）只推给任务的主人；猜不准是谁的就不显示。
- **角色**：管理员（`--admin`）能开平台登录窗口、看 Langfuse 轨迹链接，不受额度限制。成员每天有消息、后台任务、目标检查的额度，最多同时盯 5 个目标、最短 60 分钟查一次；后台任务全局最多 4 个、每人最多 2 个同时跑，按先来后到轮流。都可以在环境变量里调，见 `deploy/cattuan.env.example`。
- **上线配置**：`PUBLIC_ORIGIN`（App 的 https 地址：来源校验、cookie 的 Secure / `__Host-` 前缀、网站的 CSP 都按它来）和 `SITES_ORIGIN`（网站的地址，单独的子域名）。本机开发都不用设。

## 平台登录（沙箱）

多人版里只有管理员能开登录窗口；服务器上没有屏幕，登录窗口开在虚拟显示上、经 noVNC 操作（见 deploy/README.md「平台登录」）。

X、Instagram、Weverse 不登录看不到帖子，B 站免登录也能读、只是偶尔会被风控（-352 / 412）。登录全程由你自己完成：

1. 在 App「+」→「社媒账号」里点某个平台的「登录」（聊天里喵团提示「请在 App 里点登录 X」时，消息下面也有按钮）。
2. 沙箱会关掉后台的无头浏览器，用同一个独立 profile 在电脑上弹出一个可见的浏览器窗口，打开该平台的登录页。
3. 在窗口里自己扫码或输入账号密码登录。喵团和沙箱从不填写、也不读取你的密码，只在之后的只读访问里沿用这个窗口留下的登录 cookie。
4. 登好后关掉窗口（或点 App 里的「完成」），沙箱回到无头模式。「平台账号」里会显示「已登录」。

注意：

- **请用小号登录**。自动化浏览器访问即使只读、低频，也可能被平台判定为异常，导致验证、限流甚至封号，这个风险需要你自己承担。
- 沙箱只读：只搜账号、读时间线里的图片帖子，不发帖、不点赞、不关注、不私信。只读你在喵团里关注或点名的公开账号。
- 低频：所有访问串行排队；同一平台两次页面访问至少间隔 5 秒；时间线缓存 10 分钟、搜索缓存 1 小时；无头页面不加载图片和视频。
- Weverse 还需要在登录窗口里打开对应社区、点「加入」，才看得到艺人帖子。
- 退出登录：点「重新登录」在窗口里退出，或者停掉沙箱后删除 `sandbox/profile`（会清掉所有平台的登录和微博访客 cookie）。
- 沙箱接口：`GET /sessions` 看各平台登录状态；`GET /login?platform=x|instagram|weverse|bilibili` 打开登录窗口；`GET /login/done` 结束登录；`GET /<platform>/search_users?q=`、`GET /<platform>/timeline?uid=&days=` 返回 `{post_id, ts, at, author, text, url, images: [{large, thumb}]}`。没登录时返回 401 `{error: "login_required", message}`。

## 调试：轨迹分析（Langfuse）

调度者和 App 侧的任务轨迹可以在本机自托管的 [Langfuse](https://langfuse.com)（MIT）里按任务看。可选，不开不影响使用。

```bash
brew install colima docker docker-compose   # 没有 docker 的话
scripts/start-langfuse.sh                   # 第一次要拉镜像，几分钟
scripts/restart.sh app
```

- 第一次运行会随机生成 `langfuse/.env`（数据库密码、项目 key、登录账号，不进仓库），启动 `langfuse/docker-compose.yml`，把项目 key 写入 `agent-home/.env`。App 使用 `CATTUAN_LANGFUSE_*` 配置采集。
- 打开 http://localhost:3000 ，账号 `dev@cattuan.local`，密码在 `langfuse/.env` 的 `LANGFUSE_USER_PASSWORD`。
- 任务会话 ID 为 `task-<任务 id>`，包括「调度者 · 回消息」「后台任务 · App 侧」「调度者 · 转述结果」。普通聊天记在 `chat-<聊天 id>`，目标创建记在 `goal-<目标 id>`，目标检查记在对应任务下。App 任务卡片的「轨迹 ›」可打开任务会话。
- 当前记录范围是 BFF（`app/server.mjs`）发出的调度模型和任务生命周期轨迹，Pi 内部模型调用尚未接入此采集；工具步骤仍显示在任务详情中。
- App 通过 OTLP/HTTP 发送 span；Langfuse 未启动或发送失败只会丢轨迹，不影响任务。
- 停掉：`docker-compose -p cattuan-langfuse -f langfuse/docker-compose.yml down`（数据保留在 docker volume）；关闭记录则删除 `agent-home/.env` 中的 `CATTUAN_LANGFUSE_*` 后重启 App。

## 交互

- **聊天**：调度者（主 agent）在想、在搜、在转述时，顶栏标题下面的状态实时显示它正在做的那一步（「想想怎么回…」「上网搜「…」…」「组织回答…」「转述「…」的结果」），同时几件事会带件数；没事时显示后台任务数或「在线」。喵团在想上一条时也能接着发，每条各自回。派了后台任务时，聊天页右下角的小电视直播它在干什么；任务完成后，结果作为新消息发回，并标注「来自后台任务」。
- **输入区**（仿微信）：输入框右边是「+」，有内容时变成「发送」。点「+」弹出工具面板：相册、拍摄、记账、新目标、社媒账号。
- **社媒账号**：「+」→ 社媒账号，是一份社媒账号备忘录，平台上的公开账号（品牌、机构、博主、个人公开主页）都可以关注和读。每个平台（微博 / X / Instagram / Weverse / B 站 / 小红书）显示当前登录态、在该平台上已关注的账号，并提供登录按钮（点了会在电脑上弹出沙箱浏览器窗口，由你自己登录）。聊天里出现「登录 X」时挂的 🔑 按钮也会打开这个面板。小红书需要登录才能读，每条笔记只取封面图；登录后还能按关键词搜小红书笔记（`xiaohongshu_search`），比如问「附近有什么好吃的」，会用你共享的位置拼成「望京 美食」去搜。没关注的账号也能直接读（`official_photos` 的 `accounts` 参数）。
- **位置**：「+」→ 位置，用浏览器定位（需要在 http://localhost:3210 或 https 页面上打开），服务端用 OpenStreetMap + BigDataCloud 反查成「城市 区 街道」。精确坐标只存在 `app/data/state.json`；给调度者和执行 agent 的只有地名和约 1 公里精度的坐标，超过 24 小时就不再给。可以开「打开 App 时自动更新」（只有浏览器已授权、且上次定位超过 30 分钟才静默更新，不会弹窗）。用户问「附近」「这边」时，调度者和后台任务会按这个位置处理。
- **技能**（用户不用设置）：执行 agent 需要什么技能就自己装。遇到现有工具和技能做不好的事，它会用 `skill_store` 在本地技能和在线技能库（skills.sh 等）里找，然后安装。在线技能安装前会校验来源、路径和内容，拒绝可执行载荷与危险指令；装的原因记在 `agent-home/skills/.cattuan_installs.json`。很多技能要读网页，所以执行 agent 有只读的 `fetch_url`（只能 GET 公开网址，内网和本机地址会被拦截，限大小）。「+」→ 技能是只读面板，分「按需装的（什么时候、为什么装）/ AI 自己写的 / 喵团自带」三组，可以展开看内容。
- **目标**：持续目标，定时让执行 agent 检查（每 N 分钟或每天几点）。每个目标下面一行小字显示最新状态和更新时间；只有执行 agent 判断「有新进展」才在聊天里主动发消息，标「🎯 来自目标」；已推过的图不会重复推。可以在目标页用一句话添加，也可以在聊天里说「以后每天早上 8 点告诉我天气」「机票降到 800 以下提醒我」。支持立即检查、暂停、删除。仿 Muse：卡片左边的勾选框是「完成」（不再检查，挪到「已完成」，再点一下接着盯）；在聊天里说「那个不用盯了」也会完成；执行 agent 检查时判断事情已经彻底办完（`DONE: yes`，比如一次性提醒已发出）会自动完成。点卡片展开详情：目标说明、动态时间线（建好、每次检查的结论、暂停 / 继续、完成）和下次检查时间。有一个「AI 维护」的目标：
  - 记账管家：第一次记账时自动创建，每天 21:30 查账、更新记账记忆；超预算、某类支出异常、周日小结、疑似重复记账时才在聊天里提醒。每次记账后状态小字立刻刷新为本月和今天的支出。
- **记账**：「+」→ 记账，弹出底部面板，可以快速记一笔（支出或收入、金额、分类、备注），也能看本月汇总、明细和 AI 维护的记账记忆；也可以直接在聊天里说「午饭 35」，调度者几秒内记好。
- **深度搜索**：遇到要全面查清楚、调研、对比、找途径的问题，调度者会派「深度搜索」任务。执行 agent 按 `skills/cattuan/deep-research` 的方法做：用 `deep_web_search` 换角度搜几轮（在沙箱真实浏览器里搜必应），用 `read_webpage` 读原文，再交叉核对，最后写一份带 [n] 引用的报告。聊天里显示为「研究报告」卡片，引用可点、有来源列表；任务卡片里有「深度搜索过程」（每次搜了什么、读了哪些网页、读到没有）和浏览器回放。读网页只读：不下载文件、不访问内网，国内站点直连。不找盗版：要免费下载付费内容时，改为找图书馆数字资源、官方免费内容和正版优惠。
- **浏览器实时画面**（仿 Claude Cowork）：执行 agent 用沙箱浏览器读微博、小红书、X 等时，任务卡片里会出现一个小浏览器窗口，有地址栏、实时画面（每秒最多 4 帧）和当前在做的一步，比如「在小红书搜笔记「望京 美食」」「切到「全部」页签」。聊天里派任务那条回复下面也会挂一个小的实时画面。做完后保留最多 16 张关键帧做「回放」，加上完整的浏览过程。画面来自沙箱的 `/live`（CDP screencast 加每步截图），App 服务转发并把关键帧存到 `app/data/frames/`。只有 App 开着时才推连续画面（这时沙箱也会加载图片）；没人看时只记步骤和关键帧。
- **网站**：让喵团「把 xx 做成一个网页」（导游图、攻略页、对比表、清单、行程），执行 agent 按 `skills/cattuan/web-page` 的要求写成单文件网页，用 `publish_site` 发布（工具实现见 `app/tools/business.mjs`，网页存在 `agent-home/sites/<id>/`）；要改就说「把 xx 网站改成……」，agent 用 `read_site` 读出原网页、改完带同一个 id 发成新版本。agent 用 `check_site` 自查：沙箱（`/site/check?id=s_xxxxxxxx`，只接受网站 id，只打开 `127.0.0.1:3211/<id>/`，用不带登录 cookie 的无痕浏览器，页面里的请求只放行本网站文件和公网 https）真的打开网页，收集 JS 报错（带行号和那行代码）、加载失败的资源，可按顺序点几下按钮，首屏截图存在 `sandbox/shots/<id>/`，也会出现在任务卡片的浏览过程里。聊天里显示为带实时缩略图的网站卡片，点开是 App 内置浏览器（地址栏、刷新、新标签页打开，宽屏下可切手机/电脑宽度）；「+」→ 网站 列出所有网站。网页由 App 在 `:3211` 上单独提供：和 App 不同源，CSP 只放行 https 外链，网页里的脚本访问不到 App 接口、agent 和沙箱；App 的写接口也会拒绝来自别的源的请求。agent 没调工具、直接把整页 HTML 贴在回复里时，App 会替它发布。
- **任务**：看所有后台任务（对话任务和目标检查）的状态、执行步骤、用时、任务说明（调度者写给执行 agent 的 brief）、执行结果。进行中、排队中的任务卡片上有「停止」按钮。
- **改任务 / 停止**：对一个排队中、进行中或刚做完的任务说「不要…」「换成…」「再加上…」「这个不好」，调度者会写 `steer` 改那个任务，不另开新任务；说「别弄了」就 `stop`。App 按任务阶段处理：排队中 → 并进任务说明；进行中 → 用 Pi gateway 的 `/v1/runs/{id}/steer` 插话，agent 在下一步之前看到新要求，已经做的不丢；插话没赶上这一轮（`pending_steer`）→ 这一轮的结果先不发，在同一个会话里接着改一轮；已完成 / 失败 / 已停止 → 在同一个 Pi 会话（`task-<任务 id>`）里接着跑「第 N 轮修改」，agent 记得前面做过什么，结果更新在原任务上。任务卡片里有「修改记录」（每条要求的去向）和「第 N 轮」标记。后台任务用 `/v1/runs` 跑（POST 开始、`/events` 收事件、`/stop` 停止），App 重启时按 run id 接回还在跑的那一轮；Pi gateway 将工具执行事件连同参数、结果转成 App 现有事件格式，搜图结果、网站卡片、深度搜索过程继续显示。用户发的图片以本地路径交给 agent，由它用 `vision_analyze` 看。

## 已知限制

- 沙箱和 App 用 JS 截字符串时可能把 emoji 切成半个；发送给模型或业务工具前会清理不完整的字符。
- 调度者用 LongCat 的 JSON 模式输出；偶尔少写一个括号时，会自动补齐再解析。

- 沙箱浏览器用的是 `sandbox/chrome/` 里的副本（由 `scripts/patch-sandbox-chrome.sh` 生成）。原版 Chrome for Testing 缺少蓝牙用途声明，用 Google 账号登录 X 等网站时，会被 macOS 隐私保护直接杀掉（表现为闪退）。副本补了声明，登录时会弹出系统蓝牙授权框，选「不允许」也能正常登录。

- X、Instagram、Weverse 的读取靠拦截网页版自己的数据接口（X 的 UserTweets / SearchTimeline GraphQL、Instagram 的帖子列表 GraphQL 和 web_profile_info、Weverse 的艺人帖子接口），平台改版后可能要跟着调整解析。
- B 站频繁访问会被风控（412 / -352），通常十几分钟后自动恢复；登录后更稳定。
- 必应搜图的补充结果质量一般，靠屏蔽站点名单加 LLM 挑图来过滤。
- 一个找图任务约 20–70 秒；调度者回复约 4–6 秒；结果转述偶尔要 20 秒左右（LongCat 接口的波动）。
- App 与执行工具共用账本文件锁；同一用户从两处记账时会在锁内重读并原子写入。
- 多人时沙箱浏览器是串行的（深度搜索也走它），人多会排队。改了 `agent-home/config.yaml` 以后，新账号自动用新的，已有账号的 config.yaml 要手动同步（技能商店会改各人那份）。
