# 部署

一台 Ubuntu 24.04 服务器，用 root 操作。4 核 8G 大约够 10 个人用。App、沙箱浏览器、每个人的 agent 都只监听 127.0.0.1，对外只有 Caddy 的 80 / 443 端口。

## 首次部署

```bash
git clone https://github.com/hdy2001/CatTuan.git /srv/cattuan
APP_DOMAIN=app.example.com bash /srv/cattuan/deploy/setup.sh                # 会问 LongCat API Key
cd /srv/cattuan && sudo -u cattuan node scripts/user.mjs add <你的名字> --admin   # 建管理员，按提示设密码
```

然后打开 `https://app.example.com` 登录。

- **域名**：要先把 A 记录解析到这台服务器，Caddy 会自动申请和续期证书。没有域名就不传 `APP_DOMAIN`，用 `http://<服务器 IP>` 访问，但密码会明文传输，只适合临时用。
- **私有仓库**：在服务器上用 `ssh-keygen` 生成密钥，把公钥加成 GitHub 仓库的 Deploy key，clone 地址改用 `git@github.com:hdy2001/CatTuan.git`。

## 更新

```bash
cd /srv/cattuan && sudo -u cattuan git pull && bash deploy/setup.sh
```

`setup.sh` 可以重复跑：只补装缺少的东西，按新代码安装依赖，然后重启服务。重启前会等后台任务跑完，最多等 10 分钟；还没跑完的任务在重启后会自动续跑。

## 日常

以下命令都在 `/srv/cattuan` 下执行。

| 做什么 | 怎么做 |
| --- | --- |
| 账号 | `sudo -u cattuan node scripts/user.mjs add\|passwd\|list\|disable\|enable <名字>` |
| 日志 | `journalctl -u cattuan-app -f`（`cattuan-agents`、`cattuan-sandbox` 同理）；某个人的 agent 日志在 `app/data/users/<id>/agent-home/gateway.out` |
| 配置 | 额度、并发、注册开关在 `/etc/cattuan.env`，改完执行 `systemctl restart cattuan-app`。模型 key 在 `agent-home/.env`，改完执行 `systemctl restart cattuan-app cattuan-agents` |
| 备份 | 每天 04:00 自动备份到 `/var/backups/cattuan/`，保留 14 天。手动备份：`sudo -u cattuan bash deploy/backup.sh` |
| 恢复 | 1. `systemctl stop cattuan-app cattuan-agents`<br>2. 解开备份包，用里面的 `data/` 覆盖 `app/data/`，`agent-home/` 覆盖 `agent-home/`<br>3. `chown -R cattuan:cattuan /srv/cattuan`<br>4. 再把两个服务 `start` 起来 |

管理员在服务器上能看到所有人的数据，上线前跟同事说清楚。
