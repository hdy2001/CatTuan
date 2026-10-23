# 部署上线（多人版）

一台云服务器，给小范围同事用。推荐香港或新加坡地域：不用 ICP 备案，访问 X、Instagram 也不用代理。每个人有自己的账号，聊天、任务、目标、账本、记忆、网站互相看不到。

```
同事浏览器 ──HTTPS──► Caddy（自动证书，对外只开 80 / 443）
                        ├─ app.<域名>   ──► App :3210（登录、每个人的状态和 SSE、调度者、任务队列）
                        └─ sites.<域名> ──► 网站 :3211（agent 做的网页，和 App 不同源）
App ──按账号路由──► 执行 agent：每人一个 Pi SDK gateway（:8701、:8702 …，由 scripts/agents.mjs 守护）
    └────────────► 沙箱浏览器 :8660（大家共用，平台账号由管理员登录）
```

每个人的 Pi 会话、记忆、账本、关注和网站使用独立主目录。Pi SDK 与项目自身的 Node 业务工具直接运行，不需要其他 agent 框架或 Python 工具环境。容量请按实际模型上下文和并发量测量。

数据都在 `app/data/`（不进仓库）：

```
app/data/
  app.db                  账号、登录会话、邀请、每日用量（Node 自带的 node:sqlite）
  users/<uid>/
    state.json            聊天、任务、目标、位置
    uploads/  frames/     上传的图、浏览回放
    agent-home/          这个人的 agent 主目录：记忆、账本、关注、网站
                          （SOUL.md 链到模板；技能、config.yaml 各自一份）
      pi/sessions/        这个人的 Pi 任务会话
```

## 1. 准备

- **服务器**：Ubuntu 24.04，4 核 8G 大约够 10 个人，60G 盘。
- **两个域名**：同一个主域名下的两个子域名就行，A 记录都指向服务器，比如 `app.example.com`（App）和 `sites.example.com`（agent 做的网页）。
- **LongCat API Key**：大家共用这一个。

## 2. 装机

```bash
ssh root@<服务器>
apt-get update && apt-get install -y git
git clone <仓库地址> /srv/cattuan
APP_DOMAIN=app.example.com SITES_DOMAIN=sites.example.com bash /srv/cattuan/deploy/setup.sh
```

仓库是私有的：在服务器上 `ssh-keygen` 生成一把密钥，把公钥加成 GitHub 仓库的只读 Deploy key，仓库地址用 `git@github.com:<you>/CatTuan.git`。

`setup.sh` 可以重复跑，主要做这些事：

- 设好时区。
- 装 Node、Caddy、中文字体，以及 Xvfb / noVNC（服务器没有屏幕，平台登录窗口开在虚拟显示上）。
- 建运行用户 `cattuan`。
- 安装 App 的 Pi SDK、原生业务工具依赖，以及沙箱的 Chromium。
- 写好 `/etc/cattuan/cattuan.env` 和 `/etc/caddy/Caddyfile`。
- 注册 systemd 服务和每日备份。
- 防火墙只开 SSH、80、443。

## 3. 填 key、建管理员、启动

```bash
sudo -u cattuan nano /srv/cattuan/agent-home/.env          # 填 LONGCAT_API_KEY=…
cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs invite <你的名字> --admin
systemctl restart caddy
systemctl start cattuan-xvfb cattuan-sandbox cattuan-agents cattuan-app
```

打开第二步打印的邀请链接，设好密码就进去了。`https://sites.<域名>` 打开显示「没有这个网站」是正常的，说明网站服务通了。

## 4. 平台登录（管理员）

X、Instagram、Weverse、小红书要登录才能读。大家共用你登录的账号，建议用小号：

1. 本机开 SSH 隧道：`ssh -L 6080:127.0.0.1:6080 root@<服务器>`
2. 服务器上开网页版 VNC：`systemctl start cattuan-novnc`
3. 本机浏览器打开 http://localhost:6080/vnc.html ，点「连接」，看到的是服务器上的虚拟屏幕。
4. 在喵团里用管理员账号操作：「+」→「社媒账号」→「登录 X」。登录窗口会出现在 noVNC 里，在里面自己登录，好了点「完成」。
5. 用完关掉：`systemctl stop cattuan-novnc cattuan-vnc`

尽量在服务器上直接登录，别把本机浏览器的 cookie 拷过去：平台常把登录态和 IP 绑在一起，换了 IP 容易掉线。普通成员看得到登录状态，但没有登录按钮。

## 5. 邀请同事

```bash
cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs invite 小王
```

把打印的链接发给他。链接 7 天内有效，只能用一次。几秒内他的 agent 就会起来。

- **忘了密码**：再 `invite` 一次，等于重置密码。旧密码作废，其他设备上的登录会下线。
- **停用**：`node scripts/user.mjs disable 小王`。立刻下线，他开着的页面会退回登录页，agent 半分钟内停掉，数据保留。`enable` 恢复。
- **看所有人**：`node scripts/user.mjs list`

## 6. 额度和并发

大家共用一个 LongCat key。在 `/etc/cattuan/cattuan.env` 里调，改完 `systemctl restart cattuan-app`。管理员不受额度限制。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `QUOTA_MESSAGES_PER_DAY` | 300 | 每个成员每天最多发几条消息 |
| `QUOTA_TASKS_PER_DAY` | 40 | 每天最多派几个后台任务（含重试） |
| `QUOTA_GOAL_CHECKS_PER_DAY` | 48 | 目标每天最多检查几次，用完了当天跳过 |
| `QUOTA_GOALS` | 5 | 最多同时盯几个目标（AI 自己维护的「记账管家」不算） |
| `QUOTA_GOAL_MIN_EVERY` | 60 | 目标最短几分钟查一次 |
| `MAX_RUNNING` / `MAX_RUNNING_PER_USER` | 4 / 2 | 全局、每人同时跑几个后台任务，按先来后到轮流 |

沙箱浏览器是串行的，深度搜索也走它，所以人多时会排队。它是第一个瓶颈。

## 7. 日常运维

**更新代码**：

```bash
cd /srv/cattuan && sudo -u cattuan git pull && sudo -u cattuan bash -lc 'cd /srv/cattuan/app && npm ci --omit=dev'
systemctl restart cattuan-agents cattuan-sandbox cattuan-app
```

升级前先等任务结束并停服，备份账号库与各用户的 `agent-home`；启动时直接使用当前 Pi 数据布局。

改了 `deploy/systemd/` 里的文件，要先复制到 `/etc/systemd/system/` 再 `systemctl daemon-reload`。

**日志**：

- App：`journalctl -u cattuan-app -f`；agent 守护进程、沙箱同理。
- 某个人的 agent：`app/data/users/<uid>/agent-home/gateway.out`。

**备份**：每天 04:00 自动备份到 `/var/backups/cattuan/`，保留 14 天。SQLite 库是在线导出的一致快照。手动备份：`sudo -u cattuan /srv/cattuan/deploy/backup.sh`。建议再定期拷一份到别的机器，或用云厂商的快照。

**恢复**：

1. 停掉 `cattuan-app`、`cattuan-agents`。
2. 解开备份，`data/` 覆盖 `app/data/`，`agent-home/` 覆盖仓库的 `agent-home/`。
3. `chown -R cattuan:cattuan`，再启动服务。

**改了 `agent-home/config.yaml`**（比如加 toolset）：新账号自动用新的；已有的人每人一份 config.yaml（技能商店装技能时会改它），要手动同步过去。

## 8. 把本机的数据带上去（可选）

想让服务器上的管理员账号沿用本机单用户版的聊天、账本、记忆，在第 3 步启动服务之前做，并且用下面的 `adopt` 代替第 3 步的 `invite --admin`：

1. 先停掉本机的 App 和 agent，库文件才是完整的。
2. 把数据拷过去（从本机仓库目录执行）：

   ```bash
   rsync -az app/data/state.json app/data/frames app/data/uploads root@<服务器>:/srv/cattuan/app/data/
   rsync -az --exclude '.env' --exclude 'installs/' --exclude 'cache/' --exclude 'logs/' --exclude 'plugins/langfuse/' \
     --exclude '*.lock' --exclude 'gateway*' agent-home/ root@<服务器>:/srv/cattuan/agent-home/
   ```

3. 在服务器上执行：

   ```bash
   chown -R cattuan:cattuan /srv/cattuan
   cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs adopt <你的名字>
   ```

   这一步把聊天、任务、目标归到你的账号下，agent 沿用仓库的 agent-home。它会打印设密码的链接。

## 安全须知

- **管理员看得到**：管理员在服务器上能看到所有人的数据（状态文件、agent 的会话文件、Langfuse 轨迹），提前跟同事说清楚。
- **别放敏感内容**：服务器不在公司内网，别在里面处理公司敏感信息。
- **Langfuse**：先别和业务放在同一台 8G 机器上，ClickHouse 很吃内存。当前采集 App/BFF 侧的调度模型与任务生命周期，可能包含完整对话和任务说明，只给管理员看；Pi 内部模型调用尚未接入该采集。App 里的「轨迹」链接只对管理员显示。
- **网站是公开的**：agent 做的网页知道链接就能看，网站 id 是随机的，不登录也能打开（方便分享）。
