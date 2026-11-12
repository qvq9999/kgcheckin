// 酷狗组队接口封装（概念版「组队瓜分畅听VIP」活动）
//
// 接口由本地 api 服务代理，路由来自 api/module/team_*.js：
//   GET  /team/period/info        本期活动信息
//   GET  /team/my/info            我创建的 / 我加入的队伍
//   POST /team/my                 创建队伍
//   POST /team/join               加入队伍
//
// 归一化与错误码分类移植自 EchoMusic 的 auto-team-vip 插件（index.js:372-480），
// 那套字段兼容表和多组实测错误码是长期踩坑的产物，直接复用。

const API_BASE = 'http://127.0.0.1:3000'
const TIMEOUT_MS = 12000

/** 队伍目标人数：1 队长 + 2 队员 */
const TARGET_MEMBERS = 3

/** 与验证码无关的业务终态错误码：即使响应带 ssaCode 也不该弹验证 */
const BIZ_JOIN_CODES = new Set([143001, 143004, 143010, 143005, 20006])

/** 从多个候选键里取第一个有值的 */
function pick(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return fallback
}

/**
 * 单次请求，不自动重试。
 * 组队流程里重试语义复杂（join 重试可能重复入队），由调用方按错误类型决定。
 *
 * 注意：本地 api 服务挂了 2 分钟 HTTP 缓存（api/server.js 的 apicache 中间件）。
 * 组队是「查询 → 建队 → 立即重查」的强时序流程，命中缓存会读到建队前的旧快照，
 * 表现为"建队成功但查不到队伍"。这里统一加时间戳旁路，代价只是多一个被模块忽略的参数。
 */
async function teamFetch(path, method = 'GET', headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const bust = `_ts=${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const url = API_BASE + path + (path.includes('?') ? '&' : '?') + bust
  try {
    const resp = await fetch(url, { method, headers, signal: controller.signal })
    clearTimeout(timer)
    let body = null
    try {
      body = await resp.json()
    } catch {
      body = null
    }
    return { ok: true, status: resp.status, body }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, status: 0, body: null, error: e?.message || String(e) }
  }
}

/** 期次信息归一化 */
function normalizePeriod(body) {
  const d = body?.data ?? body ?? {}
  const current = d?.current_period_info ?? d?.period_info ?? d
  const total = Number(
    pick(current, ['team_member_count', 'member_count', 'team_num', 'target_member', 'limit', 'need_count'], TARGET_MEMBERS),
  )
  const statusRaw = Number(pick(current, ['status'], -1))
  return {
    periodId: String(pick(current, ['id', 'period_id', 'periodId', 'activity_id'], '')),
    periodName: String(pick(current, ['name'], '')),
    startTime: String(pick(current, ['start_time'], '')),
    endTime: String(pick(current, ['end_time'], '')),
    active: statusRaw === 0,
    totalMembers: total >= TARGET_MEMBERS ? total : TARGET_MEMBERS,
  }
}

/**
 * 两维度真实状态：我创建的队伍（队长）+ 我加入的队伍（队员，至多 1 支）。
 * joinedChecked 用于区分「明确拿到空数组」与「字段缺失」，避免误判成未入队。
 */
function normalizeTeamInfo(body) {
  const d = body?.data ?? body ?? {}

  const toMembers = (list) => {
    if (!Array.isArray(list)) return []
    const out = []
    for (const m of list.slice(0, TARGET_MEMBERS)) {
      const userid = String(pick(m, ['userid', 'user_id'], ''))
      if (!userid) continue
      out.push({
        userid,
        nick: String(pick(m, ['nick_name', 'nickname', 'nick'], '')).slice(0, 48),
        role: Number(pick(m, ['role'], 2)) === 1 ? 1 : 2,
        reward: String(pick(m, ['vip_desc', 'reward_desc'], '')).slice(0, 48),
      })
    }
    return out
  }

  const toTeam = (t) => {
    if (!t) return null
    const code = String(pick(t, ['team_code', 'code', 'teamCode'], ''))
    if (!code) return null
    const listLen = Array.isArray(t.member_list) ? t.member_list.length : 0
    const mc = listLen > 0 ? listLen : Number(pick(t, ['member_count', 'count', 'members_count', 'current_count'], 1))
    return {
      code,
      memberCount: Math.min(TARGET_MEMBERS, Math.max(1, Math.round(Number(mc) || 1))),
      captain: String(pick(t, ['captain'], '')),
      members: toMembers(t.member_list),
      vipDesc: String(pick(t, ['vip_desc'], '')),
    }
  }

  const createList = Array.isArray(d?.my_create_team_list) ? d.my_create_team_list : []
  const joinListRaw = d?.my_join_team_list
  const joinList = Array.isArray(joinListRaw) ? joinListRaw : []

  return {
    created: toTeam(createList[0]),
    joined: toTeam(joinList[0]),
    joinedChecked: Array.isArray(joinListRaw),
  }
}

/**
 * join 错误分类。
 * 实测码：143001=队伍不存在、143004=满员、143010=已是成员、143005=设备已绑队。
 * 原则：数字码证据最硬；文案关键词兜底（防官方改码）；其余一律 transient，不给队伍泼脏水。
 */
function classifyJoinError(body) {
  const errorCode = Number(pick(body, ['error_code', 'errcode', 'code'], 0))
  const errorMsg = String(pick(body, ['error_msg', 'msg', 'message'], ''))
  const msg = errorMsg.toLowerCase()

  let kind = 'transient'
  if (errorCode === 143004 || errorCode === 20006 || msg.includes('满') || msg.includes('full')) {
    kind = 'full'
  } else if (
    errorCode === 143010 ||
    errorCode === 143005 ||
    msg.includes('已加入') ||
    msg.includes('是队伍成员') ||
    msg.includes('已参') ||
    msg.includes('只能加入') ||
    msg.includes('joined')
  ) {
    kind = 'already_joined'
  } else if (
    errorCode === 143001 ||
    msg.includes('不存在') ||
    msg.includes('无效') ||
    msg.includes('已解散') ||
    msg.includes('组队码错误')
  ) {
    kind = 'invalid'
  }
  return { kind, errorCode, errorMsg }
}

/**
 * 判定 join / create 是否成功。
 * 必须显式 status === 1：否则 null / {} / 空响应都会被当成成功，静默吞掉失败。
 */
function parseJoinResponse(r) {
  const body = r?.body
  const isObj = Boolean(body) && typeof body === 'object'
  const bodyStatus = Number(pick(body, ['status'], NaN))
  const hasErrCode =
    isObj && (body.error_code !== undefined || body.errcode !== undefined || body.code !== undefined)
  const errorCode = Number(pick(body, ['error_code', 'errcode', 'code'], 0))
  const errorMsg = String(pick(body, ['error_msg', 'msg', 'message'], ''))
  const httpOk = Boolean(r?.ok) && Number(r?.status) < 400
  const bizOk = bodyStatus === 1 && (!hasErrCode || errorCode === 0)
  return { httpOk, bizOk, errorCode, errorMsg }
}

/** 是否需要走安全验证（有 ssaCode 且非已知业务终态码） */
function needsVerification(body) {
  const eventId = String(pick(body, ['ssaCode', 'eventId'], '') || '').trim()
  if (!eventId) return null
  const errorCode = Number(pick(body, ['error_code', 'errcode', 'code'], 0))
  const failed = Number(pick(body, ['status'], 1)) === 0
  if (errorCode === 20028 || (failed && !BIZ_JOIN_CODES.has(errorCode))) {
    return { eventId, errorCode }
  }
  return null
}

// ---------- 接口 ----------

/**
 * 判定一次响应是否为业务成功。
 *
 * 注意本地 api 服务的包装：上游业务错误会被统一包成 HTTP 502，body 里保留
 * error_code（见 api/util/request.js）。因此不能只看 HTTP 状态码，必须要求
 * 显式 status === 1，否则「token 失效」会被当成「没有队伍」而误触发建队。
 */
function bizFailed(r) {
  if (!r.ok) return `请求失败：${r.error || '网络异常'}`
  if (Number(r.status) >= 400) {
    const code = Number(pick(r.body, ['error_code', 'errcode', 'code'], 0))
    const msg = String(pick(r.body, ['error_msg', 'msg', 'message'], ''))
    return msg || `接口返回 HTTP ${r.status}${code ? `（错误码 ${code}）` : ''}`
  }
  if (Number(pick(r.body, ['status'], NaN)) !== 1) {
    const code = Number(pick(r.body, ['error_code', 'errcode', 'code'], 0))
    const msg = String(pick(r.body, ['error_msg', 'msg', 'message'], ''))
    return msg || `接口异常${code ? `（错误码 ${code}）` : ''}`
  }
  return null
}

async function getPeriodInfo(headers) {
  const r = await teamFetch('/team/period/info', 'GET', headers)
  const fail = bizFailed(r)
  if (fail) return { ok: false, error: fail }
  const p = normalizePeriod(r.body)
  if (!p.periodId) return { ok: false, error: '未找到活动期次' }
  return { ok: true, ...p }
}

async function getMyTeamInfo(headers, periodId) {
  const r = await teamFetch(
    `/team/my/info?period_id=${encodeURIComponent(periodId)}`,
    'GET',
    headers,
  )
  const fail = bizFailed(r)
  if (fail) {
    // 20006 实测在「该账号本期没有任何队伍」时返回（无创建、无加入）。
    // 这是正常状态而非故障：必须当作空队伍继续走建队流程，否则新人永远组不上。
    const code = Number(pick(r.body, ['error_code', 'errcode', 'code'], 0))
    if (code === 20006) {
      return { ok: true, created: null, joined: null, joinedChecked: true, status: r.status }
    }
    return { ok: false, error: fail }
  }
  return { ok: true, ...normalizeTeamInfo(r.body), status: r.status }
}

async function createTeam(headers, periodId) {
  const r = await teamFetch(`/team/my?period_id=${encodeURIComponent(periodId)}`, 'POST', headers)
  return { ...r, parsed: parseJoinResponse(r), verify: needsVerification(r.body) }
}

async function joinTeam(headers, code) {
  const r = await teamFetch(`/team/join?team_code=${encodeURIComponent(code)}`, 'POST', headers)
  return {
    ...r,
    parsed: parseJoinResponse(r),
    kind: r.ok ? classifyJoinError(r.body) : { kind: 'network', errorCode: 0, errorMsg: r.error },
    verify: needsVerification(r.body),
  }
}

export {
  TARGET_MEMBERS,
  teamFetch,
  pick,
  normalizePeriod,
  normalizeTeamInfo,
  classifyJoinError,
  parseJoinResponse,
  needsVerification,
  getPeriodInfo,
  getMyTeamInfo,
  createTeam,
  joinTeam,
}
