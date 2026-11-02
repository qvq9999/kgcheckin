# 网页控制台（Cloudflare Pages / Worker 双入口）

**主入口（推荐）**：`https://kgcheckin-console.pages.dev`
备用入口：`https://kgcheckin-web.18937159565.workers.dev`

两个入口跑的是同一份 `src/index.js`，共用同一个 KV 命名空间，数据完全一致。
之所以保留两个：`*.workers.dev` 在部分运营商会被 DNS 污染（详见「常见问题」），
Pages 走 `*.pages.dev` 更稳，可互为备份。

手机上打开 → 输一次访问口令 → 扫码确认 → 账号自动进仓库的 `USERINFO` → 每晚 01:10 定时签到。
另外可查看已添加账号的昵称、userid、今日签到状态、**VIP 到期时间**，并支持按昵称/userid 搜索。

> 配置文件约定：`wrangler.toml` 是 **Pages** 配置（Pages 只认这个文件名，不能用 `-c` 指定别的）；
> Worker 配置在 `wrangler.worker.toml`，部署时用 `-c` 显式指定。

## 安全边界（重要）

页面**只做三件事**：

1. 扫码获取酷狗登录凭证，交给 Actions 落库；
2. 读取 Actions 上报的账号元数据并展示；
3. 管理员口令下，触发固定的 `删除账号.yml` 删除某个账号。

页面对仓库**没有任何修改配置的能力**：没有写 Secret、改 workflow、改仓库设置的接口。
唯一对 GitHub 的写操作是「触发一次固定的 workflow」，凭证经 KV 一次性队列交给 Actions。

- 所有 `/api/*` 需口令：`ACCESS_TOKEN`（通用）或 `ADMIN_TOKEN`（管理员）
- `/internal/*` 仅接受 `SYNC_TOKEN`（Actions 专用）

| 口令 | 环境变量 | 能做什么 |
|---|---|---|
| 通用 | `ACCESS_TOKEN` | 查看账号、扫码添加 |
| 管理员 | `ADMIN_TOKEN` | 以上全部 + 进入「账号管理」页删除账号 |

管理员登录后**默认也落在普通主页**，右上角多一个「管理」图标进入管理页；管理页左上角
返回主页，两页底部都有「切换口令」（清掉本机口令回到输入页，不动任何账号数据）。

**登录限流**：同一 IP 连续输错 3 次锁 10 分钟（KV 计数，`expirationTtl` 自动过期）。
锁定期内即使口令正确也拒绝。计数器存在 `authfail:<ip>` / `authlock:<ip>` 两个键上。

> 6 位纯数字口令本身强度很低，限流是必要的兜底，不要把管理员口令发给别人。

`GH_PAT` 目前复用了仓库的 classic 令牌（repo + workflow 权限）。如要收紧，换成
**细粒度令牌、仅本仓库、只给 Actions 读写**后执行 `wrangler secret put GH_PAT` 即可，代码不用动。

## 部署 / 更新

```bash
cd web
npm install      # 若卡在 workerd 下载，加 --registry=https://registry.npmmirror.com
npx wrangler login
npx wrangler kv namespace create STATE      # 仅首次，把 id 填进两份配置文件
```

**Pages（主入口）**

```bash
npx wrangler pages project create kgcheckin-console --production-branch main   # 仅首次
npx wrangler pages secret put ACCESS_TOKEN --project-name kgcheckin-console
npx wrangler pages secret put SYNC_TOKEN   --project-name kgcheckin-console
npx wrangler pages secret put GH_PAT       --project-name kgcheckin-console
npx wrangler pages deploy --project-name kgcheckin-console --branch main --commit-dirty=true
```

**Worker（备用入口）**

```bash
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put GH_PAT
npx wrangler deploy -c wrangler.worker.toml
```

> Pages 改完密钥要**重新 deploy** 才生效；Worker 改密钥即时生效。

仓库侧 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 值 |
|---|---|
| `SYNC_URL` | `https://kgcheckin-console.pages.dev`（两个入口共用同一 KV，填哪个都行） |
| `SYNC_TOKEN` | 与两边的 `SYNC_TOKEN` 完全一致 |

## 工作流程

```
手机网页 ──扫码──> Worker ──触发──> 快捷添加账号.yml
                   ↑                    │
                   └──一次性领取凭证─────┘
                                        │
                                合并写入 USERINFO
                                        │
                                回传账号元数据 ──> KV ──> 网页展示
```

- 凭证只在 Worker 与 Actions 之间流转，**不回传浏览器**（扫码成功只发一次性 sessionId）
- 领取是一次性的，先删后返回
- 账号列表在「签到」或「添加」之后更新，所以「今日已签」与「VIP 到期」以最近一次运行为准

## 新增账号后立即签到

扫码成功后，「快捷添加账号」这个 run 会连做三件事：

1. 把账号合并进 `USERINFO`（已存在则更新 token）；
2. **立刻只给这一个账号签到**（`ONLY_USERID` 过滤，其他账号不参与）；
3. 把该账号的签到结果单独回传，页面轮询显示进度。

隔离机制：`main.js` 在单账号模式下只遍历目标账号，回写 `USERINFO` 时用的仍是完整列表；
KV 按 userid 合并，只覆盖自己那一条。所以其他账号的签到记录不会被改写或清零。

时间预期：领取 VIP 每成功一次间隔 30 秒，最多 8 次 —— 单账号通常 40 秒~1 分钟出结果，
领满 8 次约 4 分钟，所以该 workflow 的 timeout 设为 15 分钟，页面最多等 6 分钟。

当天已签过的账号再跑会返回"已领取"，标记 `note=already`，显示「今日已领」而不是失败。

## 常见问题

**某些网络打不开 `*.workers.dev`**：该域名在国内部分运营商会被 DNS 污染（解析到无关 IP）。
浏览器开「安全 DNS / DoH」通常能正常访问；换网络或改用 Pages 入口也可以。
这属运营商层面的问题，与部署无关。

## 本地调试

```bash
cd web
cp .dev.vars.example .dev.vars   # 填本地测试值
npx wrangler dev
```

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth` | 校验口令，返回 `role`（user / admin）；错误限流 |
| POST | `/api/qr/new` | 生成二维码（key + SVG） |
| GET | `/api/qr/status` | 查询扫码状态；成功返回一次性 sessionId 与 `existed` |
| POST | `/api/commit` | 凭证入队 + 触发 Actions；返回 `existed` |
| GET | `/api/accounts` | 账号元数据（昵称 / 签到状态 / VIP 到期 / 最近运行） |
| POST | `/api/remove` | 删除账号（仅 admin）→ 触发 `删除账号.yml` |
| GET | `/internal/pending` | Actions 领取凭证（Bearer SYNC_TOKEN） |
| POST | `/internal/sync` | Actions 上报账号状态（Bearer SYNC_TOKEN） |
| POST | `/internal/remove` | Actions 删完 USERINFO 后清 KV 那一条（Bearer SYNC_TOKEN） |

## 删除账号

`USERINFO` 是只写 Secret，Worker 读不到内容，所以删除必须在 Actions 里做：

```
页面「账号管理」→ 二次确认 → POST /api/remove（校验 admin）
  → 触发 删除账号.yml
  → removeAccount.js 读出 USERINFO、过滤掉该 userid、写回（允许写空数组 []）
  → POST /internal/remove 清掉 KV 里那条元数据
  → 页面轮询到那一行消失（约 15–40 秒）
```

保护：有任务在跑（快捷添加 / 签到）时接口直接返回 409；两个会写 `USERINFO` 的 workflow
共用 `concurrency: userinfo-write` 串行执行，避免并发 read-modify-write 互相覆盖。

## 重复扫码同一个账号

不改任何代码就已经是幂等的：`upsertUser` 命中已有 userid 时只更新 token，不新增条目。

页面会提前告知：`/api/qr/status` 返回 `existed=true` 时，扫码卡片显示
「该账号已在列表中，正在更新登录凭证并重新签到」；提交成功后标题写
「「昵称」已存在，登录凭证已更新」，而不是假的「已添加」。

适用场景：cookie/token 过期后重新扫码、换了设备重新登录、误扫一次——都会走更新而不是重复插入。

