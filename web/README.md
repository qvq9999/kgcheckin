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

页面**只做两件事**：

1. 扫码获取酷狗登录凭证，交给 Actions 落库；
2. 读取 Actions 上报的账号元数据并展示。

页面对仓库**没有任何修改配置的能力**：没有写 Secret、改 workflow、改仓库设置的接口。
唯一对 GitHub 的写操作是「触发一次固定的 `快捷添加账号.yml`」，凭证经 KV 一次性队列交给 Actions。

- 所有 `/api/*` 需访问口令 `ACCESS_TOKEN`
- `/internal/*` 仅接受 `SYNC_TOKEN`（Actions 专用）

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
| POST | `/api/auth` | 校验访问口令 |
| POST | `/api/qr/new` | 生成二维码（key + SVG） |
| GET | `/api/qr/status` | 查询扫码状态；成功返回一次性 sessionId |
| POST | `/api/commit` | 凭证入队 + 触发 Actions |
| GET | `/api/accounts` | 账号元数据（昵称 / 签到状态 / VIP 到期 / 最近运行） |
| GET | `/internal/pending` | Actions 领取凭证（Bearer SYNC_TOKEN） |
| POST | `/internal/sync` | Actions 上报账号状态（Bearer SYNC_TOKEN） |
