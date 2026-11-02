# 网页控制台（Cloudflare Pages）

线上地址：`https://kgcheckin-console.pages.dev`

手机上打开 → 输一次口令 → 扫码确认 → 账号自动进仓库的 `USERINFO` → 每晚 01:10 定时签到。
另外可查看已添加账号的昵称、userid、今日签到状态、**VIP 到期时间**，并支持按昵称/userid 搜索。

## 为什么是 Pages 而不是 Workers

`*.workers.dev` 在国内存在 DNS 污染（实测解析到 Facebook 的 IP，直接连不上）；
`*.pages.dev` 实测可正常访问，因此用 Pages 承载同一套代码（Pages Functions 就是 Workers 运行时）。
若之后绑定了自己的域名，Workers 与 Pages 都可以挂。

## 安全边界（重要）

页面**只做两件事**：

1. 扫码获取酷狗登录凭证，交给 Actions 落库；
2. 读取 Actions 上报的账号元数据并展示。

页面对仓库**没有任何修改配置的能力**：没有写 Secret、改 workflow、改仓库设置的接口。
唯一对 GitHub 的写操作是「触发一次固定的 `快捷添加账号.yml`」，凭证经 KV 一次性队列交给 Actions。
`GH_PAT` 建议用**细粒度令牌、仅本仓库、只给 Actions 读写**；即便泄露也动不了代码与 Secret。

- 所有 `/api/*` 需访问口令 `ACCESS_TOKEN`
- `/internal/*` 仅接受 `SYNC_TOKEN`（Actions 专用）

## 部署 / 更新

```bash
cd web
npm install

npx wrangler login
npx wrangler pages project create kgcheckin-console --production-branch main   # 仅首次

npx wrangler pages secret put ACCESS_TOKEN --project-name kgcheckin-console
npx wrangler pages secret put SYNC_TOKEN   --project-name kgcheckin-console
npx wrangler pages secret put GH_PAT       --project-name kgcheckin-console

npx wrangler pages deploy --project-name kgcheckin-console --branch main --commit-dirty=true
```

> **改完密钥要重新 deploy 才生效**（Pages 的 secret/vars 变更不会自动作用到已有部署）。

仓库侧 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 值 |
|---|---|
| `SYNC_URL` | 站点域名，如 `https://kgcheckin-console.pages.dev` |
| `SYNC_TOKEN` | 与 Pages 里的 `SYNC_TOKEN` 完全一致 |

## 工作流程

```
手机网页 ──扫码──> Pages Functions ──触发──> 快捷添加账号.yml
                        ↑                        │
                        └──一次性领取凭证─────────┘
                                                 │
                                         合并写入 USERINFO
                                                 │
                                         回传账号元数据 ──> KV ──> 网页展示
```

- 凭证只在 Pages 与 Actions 之间流转，**不回传浏览器**（扫码成功只发一次性 sessionId）
- 领取是一次性的，先删后返回
- 账号列表在「签到」或「添加」之后更新，所以「今日已签」与「VIP 到期」以最近一次运行为准

## 本地调试

```bash
cd web
cp .dev.vars.example .dev.vars   # 填本地测试值
npx wrangler pages dev          # 或 npx wrangler dev（Worker 形态）
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
