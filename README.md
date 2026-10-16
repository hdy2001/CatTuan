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
        执行 agent（Hermes :8650，工具：搜索 / 社媒账号 / 做网页 / 搜图 / 识图 / 记忆 / 记账 / 技能）
          │  official_account / official_photos ──► 沙箱浏览器（sandbox :8660，独立 profile 的无头 Chromium）
          │        ──► 微博（访客）/ B 站（免登录）/ X、Instagram、Weverse（用户在沙箱窗口里自己登录）
          │  idol_photo_search ──► 必应图片搜索
          ▼
        结果 ──► 调度者转成聊天消息（默认 1–2 句；有重要信息才多说）+ 图墙
```

```
app/            调度者 + 任务队列 + 目标调度 + Web App（聊天 / 目标 / 任务三个 Tab）+ 图片代理；状态存 app/data/state.json
sandbox/        沙箱浏览器服务：只读访问社媒公开账号（微博 / X / Instagram / Weverse / B 站 / 小红书）、网页搜索和读网页，登录窗口；profile 在 sandbox/profile
hermes-home/    执行 agent 的 HERMES_HOME（与 ~/.hermes 隔离）
  SOUL.md                 执行 agent 人设（通用私人助理）和各类工具的用法
  plugins/official-accounts/   official_account（找/关注社媒账号）、official_photos（读账号最近的帖子）、xiaohongshu_search
  plugins/idol-photos/         idol_photo_search（按关键词搜公开图片，工具名沿用旧版）
  plugins/ledger/              记账工具（ledger_add / ledger_query / ledger_delete / ledger_memory）
  ledger/entries.json          账本（App 记账面板、聊天记账、执行 agent 共用）
  ledger/LEDGER.md             记账记忆（预算、固定收支、消费习惯），AI 维护
  skills/cattuan/              喵团技能：deep-research（深度搜索）、web-page（做网页）、ledger-weekly-report（记账周报）等
  skills-archive/              不再使用的追星技能（comeback-tracker、birthday-support），Hermes 不加载
  skills/<其他>                Hermes 自带的 58 个通用技能，默认停用（config.yaml 的 skills.disabled）
  official_accounts.json       已关注的社媒账号
  memories/USER.md             记住的用户画像和偏好
hermes-agent/   上游 NousResearch/hermes-agent（MIT），未改动
scripts/        start.sh 一键启动三个服务；restart.sh 等没有进行中的任务再重启（重启前没跑完的任务也会自动续跑）（start-sandbox.sh / start-agent.sh / start-app.sh 可单独启动）
```

## 启动

第一次（需要 Node 20+、Python 3.11+、Chrome 或 Playwright 的 Chromium）：

```bash
git clone --recurse-submodules <仓库地址> CatTuan && cd CatTuan   # hermes-agent 是子模块，锁在验证过的版本
python3 -m venv hermes-agent/.venv && hermes-agent/.venv/bin/pip install -e hermes-agent   # 装 Hermes
cd sandbox && npm install && cd ..                                # 装 playwright-core（复用本机 Playwright 缓存的 Chromium）
cp hermes-home/.env.example hermes-home/.env                      # 填上自己的 LONGCAT_API_KEY
```

以后每次：

```bash
scripts/start.sh                     # sandbox :8660 + agent :8650 + app http://localhost:3210
```

- `LONGCAT_API_KEY`：优先读 `hermes-home/.env`，其次读 `~/.hermes/.env`。agent 自己的 API server 配置（`API_SERVER_*`，带随机 key）第一次启动时自动写进 `hermes-home/.env`。
- 仓库里只有代码和配置。运行时数据都在本机、不进仓库（见 `.gitignore`）：聊天记录 `app/data/`、沙箱浏览器的登录态 `sandbox/profile/`，以及 `hermes-home/` 下的会话数据库、记忆、账本、关注列表、日志、生成的网站、自动装的技能。所以每个人的喵团各用各的数据和登录。
- 图片代理沿用 `~/.hermes/.env` 里的 `HTTP(S)_PROXY`，取 twimg、cdninstagram 等国内直连不了的图床；各平台图床（sinaimg、hdslb、twimg、cdninstagram / fbcdn、wevpstatic）会自动补 Referer。
- 沙箱浏览器同样沿用这个代理访问 X / Instagram / Weverse（也可以单独设 `SANDBOX_PROXY`），微博、B 站始终直连。

## 平台登录（沙箱）

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

## 交互

- **聊天**：调度者回复后，如果派了后台任务，回复下面会挂一个实时状态条（当前步骤 + 计时），点击跳到「任务」。任务完成后，结果作为新消息发回，并标注「来自后台任务」。
- **输入区**（仿微信）：输入框右边是「+」，有内容时变成「发送」。点「+」弹出工具面板：相册、拍摄、记账、新目标、社媒账号。
- **社媒账号**：「+」→ 社媒账号，是一份社媒账号备忘录，平台上的公开账号（品牌、机构、博主、个人公开主页）都可以关注和读。每个平台（微博 / X / Instagram / Weverse / B 站 / 小红书）显示当前登录态、在该平台上已关注的账号，并提供登录按钮（点了会在电脑上弹出沙箱浏览器窗口，由你自己登录）。聊天里出现「登录 X」时挂的 🔑 按钮也会打开这个面板。小红书需要登录才能读，每条笔记只取封面图；登录后还能按关键词搜小红书笔记（`xiaohongshu_search`），比如问「附近有什么好吃的」，会用你共享的位置拼成「望京 美食」去搜。没关注的账号也能直接读（`official_photos` 的 `accounts` 参数）。
- **位置**：「+」→ 位置，用浏览器定位（需要在 http://localhost:3210 或 https 页面上打开），服务端用 OpenStreetMap + BigDataCloud 反查成「城市 区 街道」。精确坐标只存在 `app/data/state.json`；给调度者和执行 agent 的只有地名和约 1 公里精度的坐标，超过 24 小时就不再给。可以开「打开 App 时自动更新」（只有浏览器已授权、且上次定位超过 30 分钟才静默更新，不会弹窗）。用户问「附近」「这边」时，调度者和后台任务会按这个位置处理。
- **技能**（用户不用设置）：执行 agent 需要什么技能就自己装。遇到现有工具和技能做不好的事，它会用 `skill_store` 在本地 57 个备用内置技能和在线技能库（skills.sh 等）里找，然后安装。在线技能装之前会过 Hermes 的安全扫描，扫描不过的装不上；装的原因记在 `hermes-home/skills/.cattuan_installs.json`。很多技能要读网页，所以执行 agent 有只读的 `fetch_url`（只能 GET 公开网址，内网和本机地址会被拦截，限大小）。「+」→ 技能是只读面板，分「按需装的（什么时候、为什么装）/ AI 自己写的 / 喵团自带」三组，可以展开看内容。
- **目标**：持续目标，定时让执行 agent 检查（每 N 分钟或每天几点）。每个目标下面一行小字显示最新状态和更新时间；只有执行 agent 判断「有新进展」才在聊天里主动发消息，标「🎯 来自目标」；已推过的图不会重复推。可以在目标页用一句话添加，也可以在聊天里说「以后每天早上 8 点告诉我天气」「机票降到 800 以下提醒我」。支持立即检查、暂停、删除。有一个「AI 维护」的目标：
  - 记账管家：第一次记账时自动创建，每天 21:30 查账、更新记账记忆；超预算、某类支出异常、周日小结、疑似重复记账时才在聊天里提醒。每次记账后状态小字立刻刷新为本月和今天的支出。
- **记账**：「+」→ 记账，弹出底部面板，可以快速记一笔（支出或收入、金额、分类、备注），也能看本月汇总、明细和 AI 维护的记账记忆；也可以直接在聊天里说「午饭 35」，调度者几秒内记好。
- **深度搜索**：遇到要全面查清楚、调研、对比、找途径的问题，调度者会派「深度搜索」任务。执行 agent 按 `skills/cattuan/deep-research` 的方法做：用 `deep_web_search` 换角度搜几轮（在沙箱真实浏览器里搜必应），用 `read_webpage` 读原文，再交叉核对，最后写一份带 [n] 引用的报告。聊天里显示为「研究报告」卡片，引用可点、有来源列表；任务卡片里有「深度搜索过程」（每次搜了什么、读了哪些网页、读到没有）和浏览器回放。读网页只读：不下载文件、不访问内网，国内站点直连。不找盗版：要免费下载付费内容时，改为找图书馆数字资源、官方免费内容和正版优惠。
- **浏览器实时画面**（仿 Claude Cowork）：执行 agent 用沙箱浏览器读微博、小红书、X 等时，任务卡片里会出现一个小浏览器窗口，有地址栏、实时画面（每秒最多 4 帧）和当前在做的一步，比如「在小红书搜笔记「望京 美食」」「切到「全部」页签」。聊天里派任务那条回复下面也会挂一个小的实时画面。做完后保留最多 16 张关键帧做「回放」，加上完整的浏览过程。画面来自沙箱的 `/live`（CDP screencast 加每步截图），App 服务转发并把关键帧存到 `app/data/frames/`。只有 App 开着时才推连续画面（这时沙箱也会加载图片）；没人看时只记步骤和关键帧。
- **网站**：让喵团「把 xx 做成一个网页」（导游图、攻略页、对比表、清单、行程），执行 agent 按 `skills/cattuan/web-page` 的要求写成单文件网页，用 `publish_site` 发布（插件 `hermes-home/plugins/site-builder`，网页存在 `hermes-home/sites/<id>/`）；要改就说「把 xx 网站改成……」，agent 用 `read_site` 读出原网页、改完带同一个 id 发成新版本。agent 用 `check_site` 自查：沙箱（`/site/check?id=s_xxxxxxxx`，只接受网站 id，只打开 `127.0.0.1:3211/<id>/`，用不带登录 cookie 的无痕浏览器，页面里的请求只放行本网站文件和公网 https）真的打开网页，收集 JS 报错（带行号和那行代码）、加载失败的资源，可按顺序点几下按钮，首屏截图存在 `sandbox/shots/<id>/`，也会出现在任务卡片的浏览过程里。聊天里显示为带实时缩略图的网站卡片，点开是 App 内置浏览器（地址栏、刷新、新标签页打开，宽屏下可切手机/电脑宽度）；「+」→ 网站 列出所有网站。网页由 App 在 `:3211` 上单独提供：和 App 不同源，CSP 只放行 https 外链，网页里的脚本访问不到 App 接口、agent 和沙箱；App 的写接口也会拒绝来自别的源的请求。agent 没调工具、直接把整页 HTML 贴在回复里时，App 会替它发布。
- **任务**：看所有后台任务（对话任务和目标检查）的状态、执行步骤、用时、任务说明（调度者写给执行 agent 的 brief）、执行结果。进行中、排队中的任务卡片上有「停止」按钮。
- **改任务 / 停止**：对一个排队中、进行中或刚做完的任务说「不要…」「换成…」「再加上…」「这个不好」，调度者会写 `steer` 改那个任务，不另开新任务；说「别弄了」就 `stop`。App 按任务阶段处理：排队中 → 并进任务说明；进行中 → 用 Hermes `/v1/runs/{id}/steer` 插话，agent 在下一步之前看到新要求，已经做的不丢；插话没赶上这一轮（`pending_steer`）→ 这一轮的结果先不发，在同一个会话里接着改一轮；已完成 / 失败 / 已停止 → 在同一个 Hermes 会话（`task-<任务 id>`）里接着跑「第 N 轮修改」，agent 记得前面做过什么，结果更新在原任务上。任务卡片里有「修改记录」（每条要求的去向）和「第 N 轮」标记。后台任务用 `/v1/runs` 跑（POST 开始、`/events` 收事件、`/stop` 停止），App 重启时按 run id 接回还在跑的那一轮；runs 的事件流里没有工具参数和结果，所以 `hermes-home/plugins/cattuan-bridge` 在 pre/post_tool_call 钩子里把它们推到 App 的 `/api/agent/tool`（用 agent 的 API key 认），App 按 tool_call_id 对上，搜图结果、网站卡片、深度搜索过程照常显示。用户发的图片以本地路径交给 agent，由它用 `vision_analyze` 看。

## 已知限制

- 沙箱和 App 用 JS 截字符串时可能把 emoji 切成半个，Hermes（Python）存结果时会因此报错、把任务标成失败。现在沙箱出口、App 发给 Hermes / LongCat 的请求、官方号插件三处都会清掉半个字符。
- 调度者用 LongCat 的 JSON 模式输出；偶尔少写一个括号时，会自动补齐再解析。

- 沙箱浏览器用的是 `sandbox/chrome/` 里的副本（由 `scripts/patch-sandbox-chrome.sh` 生成）。原版 Chrome for Testing 缺少蓝牙用途声明，用 Google 账号登录 X 等网站时，会被 macOS 隐私保护直接杀掉（表现为闪退）。副本补了声明，登录时会弹出系统蓝牙授权框，选「不允许」也能正常登录。

- X、Instagram、Weverse 的读取靠拦截网页版自己的数据接口（X 的 UserTweets / SearchTimeline GraphQL、Instagram 的帖子列表 GraphQL 和 web_profile_info、Weverse 的艺人帖子接口），平台改版后可能要跟着调整解析。
- B 站频繁访问会被风控（412 / -352），通常十几分钟后自动恢复；登录后更稳定。
- 必应搜图的补充结果质量一般，靠屏蔽站点名单加 LLM 挑图来过滤。
- 一个找图任务约 20–70 秒；调度者回复约 4–6 秒；结果转述偶尔要 20 秒左右（LongCat 接口的波动）。
- App 写账本没有加文件锁（插件用 `ledger/.lock`），都是写前重读加原子替换，单用户场景下基本不会冲突。
