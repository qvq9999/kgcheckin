# 网页控制台（Cloudflare Worker）

手机上打开一个网页 → 扫码 → 账号自动加入仓库的 `USERINFO` → 每晚 01:10 定时签到。
另外可以查看已添加账号的昵称、userid、今日签到状态和 **VIP 到期时间**，并支持搜索。

## 安全边界（重要）

页面**只做两件事**：

1. 扫码获取酷狗登录凭证，交给 Actions 落库；
2. 读取 Actions 上报的账号元数据并展示。

页面对仓库**没有任何修改配置的能力**：没有写 Secret、改 workflow、改仓库设置的接口。
唯一对 GitHub 的写操作是「触发一次固定的 `快捷添加账号.yml`」，凭证通过 Worker 的一次性队列交给 Actions。
因此 Worker 里的 `GH_PAT` 只需要：

- 细粒度令牌，仅限本仓库
- **Actions: Read and write**（触发 workflow、查运行状态）

不需要 Contents、不需要 Secrets 权限。即使这个令牌泄露，也改不了代码、读不了仓库内容、写不了 Secret。

访问口令 `ACCESS_TOKEN` 保护所有 `/api/*`；`SYNC_TOKEN` 只用于 Actions ↔ Worker 的内部接口。

## 一次性部署

```bash
cd web
npm install

# 1) 登录 Cloudflare
npx wrangler login

# 2) 建 KV 命名空间，把输出的 id 填进 wrangler.toml
npx wrangler kv namespace create STATE

# 3) 设置三个密钥
npx wrangler secret put ACCESS_TOKEN   # 网页访问口令，自己定一个足够长的
npx wrangler secret put SYNC_TOKEN     # Actions 上报/领取用的令牌，随机长串
npx wrangler secret put GH_PAT         # 细粒度 PAT，仅 Actions 读写

# 4) 部署
npx wrangler deploy
```

部署后记下 Worker 域名（形如 `https://kgcheckin-web.<账号>.workers.dev`），回到仓库
Settings → Secrets and variables → Actions 添加两个 Secret：

| Secret | 值 |
|---|---|
| `SYNC_URL` | Worker 域名，如 `https://kgcheckin-web.xxx.workers.dev` |
| `SYNC_TOKEN` | 与上面 `wrangler secret put SYNC_TOKEN` 完全一致 |

最后跑一次「签到」或从网页添加一个账号，页面就会有数据（首次为空是正常的，列表由 Actions 上报）。

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

- 凭证（token）只在 Worker 内存/KV 与 Actions 之间流转，**不会回传浏览器**；
- 领取是一次性的，用后即删；
- 账号列表只在签到/添加后更新，所以「今日已签」和「VIP 到期」以最近一次运行为准。

## 本地调试

```bash
cd web
cp .dev.vars.example .dev.vars   # 填入本地测试用的三个值
npx wrangler dev
```

`.dev.vars` 已在 `.gitignore` 中，不会提交。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth` | 校验访问口令 |
| POST | `/api/qr/new` | 生成二维码（返回 key + SVG） |
| GET | `/api/qr/status` | 查询扫码状态；成功时返回一次性 sessionId |
| POST | `/api/commit` | 凭证入队 + 触发 Actions |
| GET | `/api/accounts` | 账号元数据（昵称 / 签到状态 / VIP 到期） |
| GET | `/internal/pending` | Actions 领取凭证（Bearer SYNC_TOKEN） |
| POST | `/internal/sync` | Actions 上报账号状态（Bearer SYNC_TOKEN） |
