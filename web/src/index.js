// 酷狗签到 · 网页加账号（Cloudflare Worker）
// 路由：
//   POST /api/auth          校验访问口令
//   POST /api/qr/new        生成二维码（返回 key + SVG）
//   GET  /api/qr/status     查询扫码状态；status=4 时写会话并返回 sessionId
//   POST /api/commit        把会话凭证挂到待领取队列 + 触发 Actions（不写任何仓库配置）
//   GET  /api/accounts      读取账号元数据（来自 Actions 同步）
//   GET  /internal/pending  Actions 来领取待添加的凭证（Bearer SYNC_TOKEN，一次性）
//   POST /internal/sync     Actions 上报账号状态（Bearer SYNC_TOKEN）
// 设计要点：
//   1. token 只在 Worker 内流转，永远不回传浏览器；
//   2. 页面没有任何写仓库配置的接口，唯一动作是"触发一次固定 workflow"；
//   3. 因此 GH_PAT 只需 Actions 读写权限，拿不到代码、改不了 Secret。
import qrcode from 'qrcode-generator'
import { createQrKey, checkQrKey } from './kugou.js'
import { dispatchWorkflow, latestRun } from './github.js'

const SESSION_TTL = 600

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const bad = (msg, status = 400) => json({ ok: false, error: msg }, status)

function timingSafeEqual(a, b) {
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  if (sa.length !== sb.length) return false
  let diff = 0
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i)
  return diff === 0
}

function authed(request, env) {
  const header = request.headers.get('X-Auth') || ''
  return Boolean(env.ACCESS_TOKEN) && timingSafeEqual(header, env.ACCESS_TOKEN)
}

function qrSvg(url) {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

function sessionKey(id) {
  return `sess:${id}`
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      if (path === '/api/auth') {
        if (request.method !== 'POST') return bad('method not allowed', 405)
        if (!authed(request, env)) return bad('口令不正确', 401)
        return json({ ok: true })
      }

      if (path === '/api/qr/new') {
        if (request.method !== 'POST') return bad('method not allowed', 405)
        if (!authed(request, env)) return bad('口令不正确', 401)
        const { key, url: qrUrl } = await createQrKey()
        return json({ ok: true, key, svg: qrSvg(qrUrl) })
      }

      if (path === '/api/qr/status') {
        if (!authed(request, env)) return bad('口令不正确', 401)
        const key = url.searchParams.get('key')
        if (!key) return bad('缺少 key')
        const st = await checkQrKey(key)

        if (st.status === 4 && st.token && st.userid) {
          // 凭证落到 KV，浏览器只拿到一次性 sessionId
          const id = crypto.randomUUID()
          await env.STATE.put(
            sessionKey(id),
            JSON.stringify({
              userid: String(st.userid),
              token: st.token,
              nickname: st.nickname || '',
              at: Date.now(),
            }),
            { expirationTtl: SESSION_TTL }
          )
          return json({ ok: true, status: 4, nickname: st.nickname || '', sessionId: id })
        }
        return json({ ok: true, status: st.status ?? 0 })
      }

      if (path === '/api/commit') {
        if (request.method !== 'POST') return bad('method not allowed', 405)
        if (!authed(request, env)) return bad('口令不正确', 401)

        const { sessionId } = await request.json().catch(() => ({}))
        if (!sessionId) return bad('缺少 sessionId')

        const raw = await env.STATE.get(sessionKey(sessionId))
        if (!raw) return bad('登录已过期，请重新扫码', 410)

        const cred = JSON.parse(raw)
        // 凭证放进一次性队列，由 Actions 主动领取：
        // 这样页面侧不写任何仓库配置（Secret / workflow 文件都不碰）
        const pendingId = crypto.randomUUID()
        await env.STATE.put(
          `pending:${pendingId}`,
          JSON.stringify({ userid: cred.userid, token: cred.token, nickname: cred.nickname, at: Date.now() }),
          { expirationTtl: SESSION_TTL }
        )

        try {
          await dispatchWorkflow({
            token: env.GH_PAT,
            repo: env.GH_REPO,
            workflow: env.ADD_WORKFLOW || '快捷添加账号.yml',
            ref: env.GH_REF || 'main',
            inputs: { pending_id: pendingId },
          })
        } catch (e) {
          await env.STATE.delete(`pending:${pendingId}`)
          throw e
        }

        await env.STATE.delete(sessionKey(sessionId))

        // 立刻把新账号写进本地元数据，页面不用等 Actions 就能看到（昵称为空时后续同步会补）
        await mergeAccounts(env, [{ userid: cred.userid, nickname: cred.nickname }], { touch: false })

        return json({ ok: true, userid: cred.userid, nickname: cred.nickname, pendingId })
      }

      if (path === '/internal/pending') {
        const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
        if (!env.SYNC_TOKEN || !timingSafeEqual(token, env.SYNC_TOKEN)) return bad('forbidden', 403)

        const id = url.searchParams.get('id')
        if (!id) return bad('缺少 id')

        const raw = await env.STATE.get(`pending:${id}`)
        if (!raw) return bad('待添加凭证不存在或已过期', 404)

        // 一次性领取：先删再返回，避免重复添加
        await env.STATE.delete(`pending:${id}`)
        return json({ ok: true, ...JSON.parse(raw) })
      }

      if (path === '/api/accounts') {
        if (!authed(request, env)) return bad('口令不正确', 401)
        const state = await readState(env)
        let run = null
        try {
          run = await latestRun({ token: env.GH_PAT, repo: env.GH_REPO, workflow: env.ADD_WORKFLOW || '快捷添加账号.yml' })
        } catch {
          run = null
        }
        return json({ ok: true, ...state, latestRun: run })
      }

      if (path === '/internal/sync') {
        if (request.method !== 'POST') return bad('method not allowed', 405)
        const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
        if (!env.SYNC_TOKEN || !timingSafeEqual(token, env.SYNC_TOKEN)) return bad('forbidden', 403)

        const body = await request.json().catch(() => null)
        if (!body || !Array.isArray(body.accounts)) return bad('accounts 必须是数组')

        const state = await mergeAccounts(env, body.accounts, { touch: true, source: body.source })
        return json({ ok: true, total: state.accounts.length, updatedAt: state.updatedAt })
      }

      if (path.startsWith('/api/')) return bad('not found', 404)

      if (env.ASSETS) return env.ASSETS.fetch(request)
      return new Response('Not Found', { status: 404 })
    } catch (e) {
      return json({ ok: false, error: e && e.message ? e.message : String(e) }, 500)
    }
  },
}

async function readState(env) {
  const raw = await env.STATE.get('accounts')
  if (!raw) return { accounts: [], updatedAt: null }
  try {
    const parsed = JSON.parse(raw)
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      updatedAt: parsed.updatedAt || null,
      source: parsed.source || null,
    }
  } catch {
    return { accounts: [], updatedAt: null }
  }
}

/**
 * 按 userid 合并账号元数据。
 * 只存昵称 / 签到状态 / VIP 到期时间，绝不存 token。
 */
async function mergeAccounts(env, incoming, { touch = true, source = 'add' } = {}) {
  const state = await readState(env)
  const byId = new Map(state.accounts.map((a) => [String(a.userid), a]))

  for (const item of incoming) {
    const userid = String(item.userid ?? '').trim()
    if (!userid) continue
    const prev = byId.get(userid) || { userid, addedAt: new Date().toISOString() }
    const next = { ...prev }
    if (item.nickname) next.nickname = String(item.nickname)
    if (item.lastCheckin) next.lastCheckin = String(item.lastCheckin)
    if (typeof item.ok === 'boolean') next.ok = item.ok
    if (item.vipExpiry) next.vipExpiry = String(item.vipExpiry)
    if (item.error) next.error = String(item.error)
    byId.set(userid, next)
  }

  const merged = {
    accounts: [...byId.values()].sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt))),
    updatedAt: touch ? new Date().toISOString() : state.updatedAt,
    source,
  }
  await env.STATE.put('accounts', JSON.stringify(merged))
  return merged
}
