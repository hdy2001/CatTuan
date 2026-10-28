# 喵团 CatTuan

通用个人助理（Personal Agent）：查资料、深度调研、搜图识图、替你打电话，用「目标」持续替你关注事情。仿 Muse 的「主 agent + 子 agent + Goal」架构，LongCat 驱动，界面用 LongCat 品牌图标和绿色配色。

```
用户 ──► 主 agent（agent/main.mjs，每个聊天一个 Pi 会话 chat-<聊天 id>）
          │  聊天口吻短回复；一两步能办完的自己办（搜索 / 搜图 / 看图 / 记忆 / 技能；不读网页、不打电话）；
          │  复杂的事（打电话、深度调研、要好几分钟的）用 subagent 工具派子 agent；改 / 停子 agent、出提问卡、建目标；连发的消息并进同一轮
          │
目标调度器（每 30 秒看一次到期目标）──► 派「目标检查」子 agent ──► goal_update 报告结论，有新进展才由主 agent 在聊天里说
          ▼
        后台任务（core/tasks.mjs，不限并发，派出就跑；状态经 SSE 推到「任务」Tab）
          │
          ▼
        子 agent（agent/worker.mjs，同一个 Pi runtime 的 worker profile）：派出时复制主 agent 的会话（task-<任务 id>），工具一样，外加打电话
          │  web_search ──► 搜索后端（默认本机 DDGS 服务 search :4479，不行再用沙箱浏览器搜必应）
          │  web_fetch ──► 直接 HTTP 抓网页提取正文；read_webpage ──► 沙箱浏览器（sandbox :8660，独立 profile 的无头 Chromium）
          │  image_search ──► 必应图片搜索；phone_call ──► calls/（木星外呼平台 mt-jupiter-cli call aicall）
          ▼
        结果（文字 + attachments：图、文档、通话组件）──► 送回主 agent 的会话，由它接着说
```

主 agent 和子 agent 都在 App 进程里，用同一个 Pi runtime（`agent/runtime.mjs`），只是 profile 不同（模型、轮数上限、工具、提示词）。
代码里只有通用的结构（会话、任务、目标、工具、附件、事件）；怎么说话、什么时候派子 agent、怎么打电话、怎么写报告，都写在 `agent-home/` 的提示词和技能里。

```
app/
  server.mjs              把各模块接起来、起 HTTP 服务（:3210）
  config.mjs              所有配置（环境变量 > agent-home/.env），只在这里读一次
  agent/                  agent 层
    runtime.mjs             Pi 会话的运行时：run / steer / stop / 事件（工具事件带工具自己写的展示文字和进度）
    agents.mjs              每个账号一个 runtime，main / worker 两种 profile；会话在 <home>/pi/sessions
    main.mjs                主 agent：聊天轮次编排（插话、排队、按段发消息、挂附件）
    main-tools.mjs          主 agent 的聊天工具：subagent / steer_task / stop_task / read_task_result / ask_user / create_goal / complete_goals
    worker.mjs              子 agent 跑一轮，收齐工具交回的附件
    tools.mjs               注册业务工具、按 config.yaml 开关过滤
    context.mjs             主 agent 每轮开头的状态块、任务结果交回时的那段话
  core/                   App 的状态
    store.mjs               每个人的状态（state.json）、SSE 推送
    chats.mjs               聊天、消息、顶栏状态（activity）
    tasks.mjs               后台任务：排队、轮次、插话 / 停止 / 重试、App 重启后续跑
    goals.mjs               目标：定时检查、goal_update、结构化的动态
    quota.mjs / live.mjs    每日额度 / 沙箱浏览器的实时画面和回放
    migrate.mjs             老数据转新格式（scripts/migrate.mjs 用）
  tools/                  业务工具（每个工具自带 label 和 describe：任务轨迹里那一步怎么写）
    web.mjs                 网页搜索（后端可换）、读网页、用浏览器读网页、搜图
    extract.mjs             网页正文提取（Readability → Markdown）
    knowledge.mjs           记忆、技能、技能商店、翻聊天记录、看图
    business.mjs            打电话
    output.mjs              attach（附上图片 / 文档）
  calls/                  打电话：calls.mjs 通话记录，jupiter-provider.mjs 木星外呼（aicall 拨号、查话单），cli-auth.mjs 鉴权
  http/                   登录（auth）、接口路由（routes）、上传和图片代理（media）
  public/                 前端（原生 ES 模块，无构建）：app.js 入口，ui/ 下按块分（chat、tasks、goals、cards 附件……）
  data/users/<id>/        每个人的聊天、任务、目标、上传的图、回放、通话记录与 agent-home/
sandbox/        沙箱浏览器：网页搜索和读网页（只读）；profile 在 sandbox/profile/
search/         搜索服务 DDGS（Python）：requirements.txt 钉死版本，装在 search/.venv/
deploy/         部署：setup.sh 一键安装 / 更新（systemd、Caddy、每日备份），见 deploy/README.md
agent-home/     agent 的模板目录（每个账号的主目录从这里同步）；管理员也可沿用此处的本地数据
  SOUL.md                 人设和做事原则（主 agent、子 agent 共用）
  MAIN.md / WORKER.md     主 agent / 子 agent 各自的规矩
  config.yaml             工具、技能和记忆的开关
  skills/cattuan/         项目自带技能（深度搜索、打电话、本地生活）
  memories/ pi/sessions/  长期记忆、Pi 会话（运行时数据）
scripts/        start.sh 一键启动；restart.sh 等没有进行中的任务再重启；migrate.mjs 老数据迁移；start-search.sh 起搜索服务
  user.mjs                账号管理：add 建号 / passwd 改密码 / list / disable / enable / adopt（从单用户版升级）
```

## 启动

第一次（需要 Node 22.19+、Chrome 或 Playwright 的 Chromium、Python 3.10+ 和 venv）：

```bash
git clone <仓库地址> CatTuan && cd CatTuan
npm ci --omit=dev --prefix app                                    # 安装 Pi SDK（锁定 @earendil-works/pi-coding-agent 1.3.0）
npm ci --omit=dev --prefix sandbox                                # 装 playwright-core（复用本机 Playwright 缓存的 Chromium）
python3 -m venv search/.venv && search/.venv/bin/pip install -r search/requirements.txt   # 搜索服务 DDGS
cp agent-home/.env.example agent-home/.env                        # 填上自己的 LONGCAT_API_KEY
node scripts/user.mjs add <你的名字> --admin                         # 建管理员账号，按提示设密码
```

以后每次：

```bash
scripts/start.sh                     # sandbox :8660 + search :4479 + app http://localhost:3210
```

从老版本升级：先停掉 App（和老版本的 agent 守护进程），再跑一次 `node scripts/migrate.mjs`（`--dry-run` 先看要改什么）。它会先在 `app/data/backups/` 打一个备份包，再把老格式的消息、任务、目标、聊天会话和工具开关转成现在的格式；可以重复跑。从单用户版升级的先跑 `node scripts/user.mjs adopt <你的名字>`。

- `LONGCAT_API_KEY`：读取 `agent-home/.env`，所有账号共用。
- 子 agent 的模型可用 `PI_MODEL`、`PI_API_URL`、`PI_API_KEY` 覆盖，`PI_MAX_TOKENS` 默认 16384，`PI_CONTEXT_WINDOW` 默认 128000，`PI_MAX_TURNS` 默认 90；主 agent 用 `DISPATCH_MODEL`（要能看图）、`DISPATCH_API_URL`、`DISPATCH_MAX_TURNS`（默认 10）、`DISPATCH_MAX_TOKENS`（默认 8192）。达到限制会明确标记失败。两边默认都开思考，思考也算输出 token（`PI_THINKING=0`、`DISPATCH_THINKING=0` 分别关掉）。模型请求多久没开始回就算超时并重试一次：主 agent `DISPATCH_TIMEOUT_MS` 默认 60000，子 agent `PI_TIMEOUT_MS` 默认 180000（只管到开始回为止，长回答不受影响）；主 agent 这一轮失败时会告诉用户一声。
- `config.yaml` 管工具开关（`toolsets`：images 搜图、vision 看图、memory 记忆、session_search 翻聊天记录、skills 技能、web 网页、phone 打电话；`disabled_tools` 单独关）、技能和记忆开关，以及搜索和读网页的后端（`web.search_backend` 默认 `[ddgs, browser]`：先用 DDGS，出错或没结果再用沙箱浏览器；`web.fetch_backend` 默认 `http`）。要接别的搜索服务（Brave、Tavily、SearXNG……）就在 `app/tools/web.mjs` 的后端表里加一个函数。
- 仓库里只有代码和配置。运行时数据都在本机、不进仓库（见 `.gitignore`）：账号库和每个人的数据 `app/data/`（聊天记录、Pi 会话、记忆、自动装的技能），以及沙箱浏览器的 profile `sandbox/profile/`。
- 沙箱浏览器使用 `agent-home/.env` 里的 `HTTP(S)_PROXY` 访问国外网站（也可以单独设 `SANDBOX_PROXY`），国内站点始终直连。搜索服务同样沿用 `HTTPS_PROXY`（或单独设 `SEARCH_PROXY`）；不在本机时用 `DDGS_URL` 指过去。
- 打电话走木星外呼平台的 CLI（`mt-jupiter-cli`），要配 `JUPITER_TENANT_ID`、`JUPITER_ROUTE_POINT` 等（见 `agent-home/.env.example`「打电话」一段）；没配时 `phone_call` 直接返回「外呼平台没配置」。可以全站配一份，也可以写进某个账号自己的 `<home>/.env` 覆盖。鉴权用 `JUPITER_AUTH` 选：`moa`（默认，CLI 用本机登录的 MOA 自己换票）、`token`（直接给 SSO token）、`command`（每次外呼前跑一条命令取 token）；加别的取票方式在 `app/calls/cli-auth.mjs` 的 `SOURCES` 里加一个函数。

## 测试

`npm test --prefix app`。只使用临时数据和本地模拟服务（模拟模型、模拟沙箱、假的外呼 CLI `app/calls/fake-cli.mjs`）；不会拨打真实电话或改动用户数据。`app/e2e.test.mjs` 在临时目录里起整套 App，经 HTTP 接口走完聊天、派子 agent、附件、插话、停止、打电话、目标、App 重启续跑和账号隔离。

## 多人使用（账号）

小范围给同事用，部署到服务器见 [deploy/README.md](deploy/README.md)。

- **账号**：名字 + 密码登录，分管理员和成员。管理员用 `node scripts/user.mjs add 小王` 建号并设密码（`--admin` 建管理员），`passwd 小王` 改密码（旧密码和所有登录作废）；`disable` 立刻下线、停掉他正在跑的任务，数据保留。调试用的 `POST /api/auth/register` 可以注册成员账号并直接登录：本机（`PUBLIC_ORIGIN` 不是 https）默认开，线上默认关，设 `ALLOW_REGISTER=1` 打开、`ALLOW_REGISTER=0` 关掉；同一 IP 15 分钟最多注册 10 个。密码用 scrypt 加盐，登录会话的 token 在库里只存哈希。
- **鉴权**：网页用 HttpOnly cookie。原生 App 登录时在请求体里加 `"token": true`（`/api/auth/login`、`/api/auth/register` 都支持），响应里返回 `token`、不下发 cookie，之后每个请求（包括 SSE `/api/events`、图片 `/api/uploads/…`）带 `Authorization: Bearer <token>`。两种是同一张会话表：30 天有效、用着自动续期，`/api/auth/logout`、`disable`、重置密码都会让它作废。接口说明见 `app/public/api-docs.html`。
- **隔离**：每个人的聊天、任务、目标、上传的图、回放、通话记录分开存，实时推送（SSE）只推给本人，拿别人的 id 调接口一律 404。每个人一个 agent 主目录（记忆、技能、Pi 会话、工具开关），工具按这个人的主目录、配置和凭据执行。
- **沙箱浏览器大家共用**：实时画面按任务编号（工具请求带的）只推给任务的主人；没带任务编号的操作不显示。
- **额度**：管理员不受限制。成员每天有消息、后台任务、目标检查的额度，最多同时盯 5 个目标、最短 60 分钟查一次。都可以在环境变量里调，线上在 `/etc/cattuan.env`（见 [deploy/README.md](deploy/README.md)）。
- **上线配置**：`PUBLIC_ORIGIN`（App 的 https 地址：来源校验、cookie 的 Secure / `__Host-` 前缀都按它来）。本机开发不用设。

## 交互

- **聊天**：主 agent 在想、在搜、在转述时，顶栏标题下面的状态实时显示它正在做的那一步（每一步的说法由工具自己写），同时几件事会带件数；没事时显示后台任务数或「在线」。喵团在想上一条时也能接着发：新消息并进正在想的那一轮（Pi 插话），几条合起来回、只办一次事。派了后台任务时，聊天页右下角的小电视直播它在干什么；任务完成后，结果作为新消息发回，并标注「来自后台任务」。
- **附件**：消息下面挂的东西都在 `attachments` 里，按类型画——图墙（agent 用 `attach` 挑的图）、文档卡片（调研报告、长清单，点开是阅读页，[n] 引用可点）、提问卡（`ask_user`）、通话组件（`phone_call` 打完自带）。
- **输入区**（仿微信）：输入框右边是「+」，有内容时变成「发送」。点「+」弹出工具面板：相册、拍摄。
- **技能**（用户不用设置）：agent 需要什么技能就自己装。遇到现有工具和技能做不好的事，它会用 `skill_store` 在本地技能和在线技能库（skills.sh 等）里找，然后安装。在线技能安装前会校验来源、路径和内容，拒绝可执行载荷与危险指令；装的原因记在 `agent-home/skills/.cattuan_installs.json`。很多技能要读网页，所以 agent 有只读的 `web_fetch`（只能 GET 公开网址，内网和本机地址会被拦截，限大小）。
- **目标**：持续目标，定时派子 agent 检查（每 N 分钟、每天几点，或到点办一次）。检查那一轮多一个 `goal_update` 工具报告结论：有新进展（notify）才交给主 agent 在建目标的那个聊天里说，标「🎯 来自目标」；已推过的图不会重复推；事情彻底办完（done）自动完成。可以在目标页用一句话添加，也可以在聊天里说「以后每天早上 8 点告诉我天气」「机票降到 800 以下提醒我」「半小时后再打一次」。支持立即检查、暂停、删除、完成。点卡片展开详情：目标说明、动态时间线和下次检查时间。
- **深度搜索**：遇到要全面查清楚、调研、对比、找途径的问题，主 agent 派子 agent 并让它先加载 `deep-research` 技能：用 `web_search` 换角度搜几轮，用 `web_fetch` 读原文（读不到的用 `read_webpage` 在沙箱浏览器里打开），再交叉核对，最后用 `attach` 附上一份带 [n] 引用的报告。读网页只读：不下载文件、不访问内网，国内站点直连。
- **打电话**：子 agent 用 `phone_call` 打（主 agent 不能打：打一通要几分钟）。什么时候该打、要约要带齐哪些信息、没接通怎么跟进、结果怎么说，都在 `phone-call` 技能里。电话由木星外呼平台的 AI 外呼 Agent 打：这通电话的要求按它写死的格式（电话号码、merchantName、purpose、category、mode、customerNeed、rejectedTerms、allowedInfo、toConfirm、pauseCases，全是字符串）放进 `--media-txt`，缺必填项就不拨；拨出去后隔一会儿查一次话单，挂断后整理成结果。平台接了这通就马上记进通话记录，打完补上结果；App 重启或任务停了又接着做时，同一个任务半小时内再打同一个号码，会接着等上一通的结果，不会给商家再打一次。等到上限（`JUPITER_RESULT_MINUTES`）还没结果的，如实告诉用户「打出去了、结果不知道」，不自动重拨。任务轨迹里实时显示排队 → 拨号 → 结果，打完挂通话组件、记进「喵团档案 → 电话」。
- **浏览器实时画面**（仿 Claude Cowork）：子 agent 用沙箱浏览器搜网页、读网页时，任务卡片里那一步下面会出现一个小浏览器窗口，有地址栏、实时画面（每秒最多 4 帧）和当前在做的一步。做完后保留最多 16 张关键帧做「回放」。只有 App 开着时才推连续画面；没人看时只记步骤和关键帧。
- **任务**：看所有后台任务（对话任务和目标检查）的状态、每一步、用时、任务说明、结果和附件。进行中、排队中的任务卡片上有「停止」按钮。
- **改任务 / 停止**：对一个排队中、进行中或刚做完的任务说「不要…」「换成…」「再加上…」，主 agent 会调 `steer_task` 改那个任务，不另开新任务；说「别弄了」就调 `stop_task`。排队中 → 并进任务说明；进行中 → 插话进这一轮，agent 在下一步之前看到新要求；插话没赶上这一轮 → 在同一个会话里接着改一轮；已完成 / 失败 / 已停止 → 在同一个 Pi 会话（`task-<任务 id>`）里接着跑「第 N 轮修改」，结果更新在原任务上。
- **App 重启**：正在跑的子 agent 会随 App 停下，重启后在原来的 Pi 会话里接着做（已经做过的不用重做）。

## 已知限制

- 主 agent 的会话 Pi 会自动压缩；删聊天时一起删。派子 agent 时复制聊天会话（`SessionManager.forkFrom`），子 agent 接着这段对话做事，task 里不用复述聊天。目标检查不复制会话，只凭目标说明做。
- 必应搜图的补充结果质量一般，靠屏蔽站点名单加 agent 挑图来过滤。
- 多人时沙箱浏览器是串行的，人多会排队；搜索默认走 DDGS、读网页默认直接抓，只有回退和 `read_webpage` 才用它。
- DDGS 是免费的元搜索，抓的是公开搜索引擎的页面：偶尔会搜不到或被限流（这时自动改用沙箱浏览器搜），对稳定性要求高就接一个付费搜索 API。
- 外呼 CLI 没有挂断命令：任务停了只是不再等结果，已经接通的电话挂不断。话单里通话文字（`recordText`）的格式还没对过真数据，现在按常见写法宽松解析。
- 改了 `agent-home/config.yaml` 以后，新账号自动用新的，已有账号的 config.yaml 要手动同步（技能商店会改各人那份）。提示词文件（SOUL / MAIN / WORKER）是链接，改模板全员生效。
