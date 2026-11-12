// 多账号自动互填队伍
//
// 场景：酷狗概念版「组队瓜分畅听VIP」需要 3 人成队。本项目原生支持多账号，
// 因此可以让账号 A 建队、B/C 用 A 的组队码加入，全程不需要第三方码池。
//
// 设计要点：
//  - **先识别现状再补位**：每个账号先查「我创建的队 / 我加入的队」，
//    本期已经组过队（比如用户在 APP 里手动做过）的账号只记账，绝不重复建队或入队。
//  - 入队即终态：酷狗不支持退队，所以任何账号本期只处理一次。
//  - 不实现验证码交互：命中 ssaCode 时记录「需人工处理」并跳过该账号。
//  - 账号多于一支队伍容量时，拆成多支（上限 2 支），避免剩下的人无处可去。
import { printBlue, printGreen, printRed, printYellow } from './colorOut.js'
import { buildTeamCookie } from './device.js'
import { maskDisplayName, maskIdentifier } from './safeLog.js'
import { createTeam, getMyTeamInfo, getPeriodInfo, joinTeam, TARGET_MEMBERS } from './team.js'

/** 单账号最大 join 尝试次数（同队重试无价值，只在网络抖动时补一次） */
const JOIN_ATTEMPTS = 2
/** 同时最多维护的队伍数：5 个账号 → 3+2 两队 */
const MAX_TEAMS = 2
/** 剩余账号少于这个数就不再另开新队，避免出现 1/3 的孤队 */
const MIN_NEW_TEAM = 2

const label = (acc) => maskDisplayName(acc.nickname) || maskIdentifier(acc.userid)

/**
 * 执行组队阶段。
 * @param {Array<{userid: string|number, token: string, nickname?: string}>} users 已完成签到的账号
 * @returns {Promise<{period: object|null, accounts: Array<object>, team: object|null, teams: Array<object>, error: string|null}>}
 */
async function runTeamStage(users) {
  const result = { period: null, accounts: [], team: null, teams: [], error: null }
  if (!Array.isArray(users) || users.length === 0) {
    result.error = '无可用账号'
    return result
  }

  const accounts = users.map((u) => ({
    userid: String(u.userid),
    nickname: u.nickname || '',
    token: u.token,
    headers: { cookie: buildTeamCookie(u) },
  }))

  const record = (acc, role, note, team, memberCount) => {
    result.accounts.push({
      userid: acc.userid,
      nickname: acc.nickname,
      role,
      teamCode: team ? team.code : '',
      memberCount: memberCount || 0,
      targetMembers: 0,
      note: note || '',
    })
  }

  // ---------- ① GUARD：期次 ----------
  let period = null
  let periodError = ''
  for (const acc of accounts) {
    const r = await getPeriodInfo(acc.headers)
    if (r.ok) {
      period = r
      break
    }
    periodError = r.error || '获取活动信息失败'
  }

  if (!period) {
    result.error = periodError || '获取活动信息失败'
    printYellow(`组队：${result.error}，本次跳过`)
    return result
  }

  const target = period.totalMembers || TARGET_MEMBERS
  result.period = {
    periodId: period.periodId,
    periodName: period.periodName,
    active: period.active,
    startTime: period.startTime,
    endTime: period.endTime,
    totalMembers: target,
  }

  if (!period.active) {
    printYellow(`组队：本期活动未开启（${period.periodName || period.periodId}），本次跳过`)
    return result
  }

  printBlue(`组队：本期「${period.periodName || period.periodId}」进行中，目标 ${target} 人`)

  // ---------- ② MYINFO：先看清每个账号本期的真实位置 ----------
  const knownTeams = [] // 本期已有队伍的账号
  const free = [] // 既没建队也没入队
  const unavailable = [] // 查询失败

  for (const acc of accounts) {
    const info = await getMyTeamInfo(acc.headers, period.periodId)
    if (!info.ok) {
      unavailable.push({ acc, note: info.error })
      continue
    }
    if (info.created) {
      acc.team = info.created
      acc.isLeader = true
      knownTeams.push(acc)
    } else if (info.joined) {
      acc.team = info.joined
      acc.isLeader = false
      knownTeams.push(acc)
    } else {
      free.push(acc)
    }
  }

  for (const { acc, note } of unavailable) {
    record(acc, 'failed', `查询队伍失败：${note}`, null, 0)
  }

  // 本期已经做过组队的账号：只记账，不再操作。
  // note 不写人数——复查后人数才准确，前端单独展示进度，避免文案与数字打架。
  for (const acc of knownTeams) {
    const t = acc.team
    const where = acc.isLeader ? '本期已建队' : '本期已入队'
    record(acc, acc.isLeader ? 'leader' : 'joined', where, t, t.memberCount)
    printGreen(`组队：${label(acc)} ${where} ${maskIdentifier(t.code)}（${t.memberCount}/${target}）`)
  }

  // 可直接续填的已有队伍（未满员，按 code 去重——自己建的队和自己加入的队可能是同一支）
  const openTeams = []
  const seenCodes = new Set()
  for (const a of knownTeams) {
    const t = a.team
    if (t.memberCount >= target || seenCodes.has(t.code)) continue
    seenCodes.add(t.code)
    openTeams.push({ code: t.code, memberCount: t.memberCount, leader: a })
  }
  openTeams.sort((a, b) => b.memberCount - a.memberCount)

  // ---------- ③ 为剩余账号寻位：续填已有队伍 → 建新队 ----------
  const teams = openTeams.slice()

  // 所有已知队伍（含已满员的），用于最终展示。
  // 满员队伍同样要进去，否则「全部账号本期已完成」会被误报成「本期尚未组队」。
  const allTeams = new Map()
  for (const a of knownTeams) {
    const t = a.team
    const cur = allTeams.get(t.code)
    if (!cur || t.memberCount > cur.memberCount) {
      allTeams.set(t.code, { code: t.code, memberCount: t.memberCount, leader: a })
    }
  }
  let newTeamCount = 0

  const openNewTeam = async (leaderAcc) => {
    const created = await createTeam(leaderAcc.headers, period.periodId)

    if (created.verify) {
      record(leaderAcc, 'failed', '建队需要安全验证，本次跳过（可在概念版 APP 内手动建队）', null, 0)
      printYellow(`组队：${label(leaderAcc)} 建队需验证码，跳过`)
      return null
    }

    if (!created.parsed.httpOk || !created.parsed.bizOk) {
      // 建队失败可能是"本期已有队伍"（例如已经在 APP 里手动建过），重查一次再定性
      const recheck = await getMyTeamInfo(leaderAcc.headers, period.periodId)
      if (recheck.ok && recheck.created) {
        const t = recheck.created
        record(leaderAcc, 'leader', '本期已建队', t, t.memberCount)
        printGreen(`组队：${label(leaderAcc)} 本期已存在队伍 ${maskIdentifier(t.code)}`)
        allTeams.set(t.code, { code: t.code, memberCount: t.memberCount, leader: leaderAcc })
        return { code: t.code, memberCount: t.memberCount, leader: leaderAcc }
      }
      if (recheck.ok && recheck.joined) {
        const t = recheck.joined
        record(leaderAcc, 'joined', '本期已入队', t, t.memberCount)
        printGreen(`组队：${label(leaderAcc)} 本期已加入队伍 ${maskIdentifier(t.code)}`)
        allTeams.set(t.code, { code: t.code, memberCount: t.memberCount, leader: leaderAcc })
        return null
      }
      record(
        leaderAcc,
        'failed',
        `建队失败：${created.parsed.errorMsg || '接口异常'}`,
        null,
        0,
      )
      printRed(`组队：${label(leaderAcc)} 建队失败：${created.parsed.errorMsg || '接口异常'}`)
      return null
    }

    // 建队响应不一定带 team_code，必须重查
    const info = await getMyTeamInfo(leaderAcc.headers, period.periodId)
    if (info.ok && info.created) {
      const t = info.created
      printGreen(`组队：${label(leaderAcc)} 已建队 ${maskIdentifier(t.code)}（${t.memberCount}/${target}）`)
      return { code: t.code, memberCount: t.memberCount, leader: leaderAcc }
    }
    record(leaderAcc, 'failed', '建队成功但未查到队伍信息', null, 1)
    return null
  }

  const joinInto = async (acc, team) => {
    for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt++) {
      const res = await joinTeam(acc.headers, team.code)

      if (res.verify) {
        return { ok: false, note: '加入需要安全验证，本次跳过（可在概念版 APP 内手动加入）' }
      }

      if (res.parsed.httpOk && res.parsed.bizOk) {
        return { ok: true, note: '已加入队伍' }
      }

      const { kind, errorCode, errorMsg } = res.kind

      if (kind === 'already_joined') {
        // 已在队中：可能是本队的补漏，也可能是本设备已绑其他队——重查确认，别瞎猜人数
        const recheck = await getMyTeamInfo(acc.headers, period.periodId)
        if (recheck.ok && recheck.created) {
          return { ok: true, note: '本期已有自己的队伍', own: recheck.created }
        }
        if (recheck.ok && recheck.joined) {
          return { ok: true, note: '本期已在其他队伍中', own: recheck.joined }
        }
        return {
          ok: false,
          note:
            errorCode === 143005
              ? '本设备已绑定其他队伍，无法再加入（请到概念版 APP 查看）'
              : '已在队伍中',
        }
      }
      if (kind === 'full') return { ok: false, note: '队伍已满员' }
      if (kind === 'invalid') return { ok: false, note: '组队码无效' }

      if (attempt >= JOIN_ATTEMPTS) {
        return { ok: false, note: errorMsg || `加入失败（错误码 ${errorCode || '未知'}）` }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    return { ok: false, note: '加入失败' }
  }

  while (free.length > 0) {
    // 先续填未满的已有队伍
    let team = teams.shift()

    if (!team) {
      if (newTeamCount >= MAX_TEAMS) break
      if (newTeamCount > 0 && free.length < MIN_NEW_TEAM) break
      const leaderAcc = free.shift()
      const opened = await openNewTeam(leaderAcc)
      if (!opened) continue // 该账号已被记账（失败或已存在队伍），继续处理下一个
      team = opened
      newTeamCount += 1
    }

    while (free.length > 0 && team.memberCount < target) {
      const acc = free.shift()
      const r = await joinInto(acc, team)

      if (r.ok && r.own) {
        // 重查发现它自己另有队伍：按真实状态记，不把它算进当前队伍
        const t = r.own
        record(
          acc,
          t.code === team.code ? 'member' : 'joined',
          t.code === team.code ? '已加入队伍' : '本期已在其他队伍中',
          t,
          t.memberCount,
        )
        if (t.code === team.code) team.memberCount = Math.min(target, t.memberCount)
        printGreen(`组队：${label(acc)} ${r.note}`)
      } else if (r.ok) {
        team.memberCount = Math.min(target, team.memberCount + 1)
        record(acc, 'member', '已加入队伍', team, team.memberCount)
        printGreen(`组队：${label(acc)} 已加入（${team.memberCount}/${target}）`)
      } else {
        record(acc, 'failed', r.note, team, team.memberCount)
        printYellow(`组队：${label(acc)} ${r.note}`)
        if (r.note === '队伍已满员') {
          team.memberCount = target
          break
        }
      }
    }

    if (team.memberCount >= target) {
      printGreen(`组队：队伍 ${maskIdentifier(team.code)} 已满员（${target}/${target}）`)
    }
    // 放回复查清单：shift 出来的队伍必须还回去，否则漏掉人数复查
    teams.push(team)
    allTeams.set(team.code, team)
  }

  for (const acc of free) {
    record(acc, 'skipped', '本期暂无可用队伍，下期自动重试', null, 0)
  }

  // ---------- ④ 复查各队真实人数 ----------
  for (const team of allTeams.values()) {
    try {
      const verify = await getMyTeamInfo(team.leader.headers, period.periodId)
      const t = verify.ok ? (verify.created || verify.joined) : null
      if (t && t.code === team.code) {
        team.memberCount = t.memberCount
        // 同步该队所有账号记录里的人数
        for (const a of result.accounts) {
          if (a.teamCode === team.code) a.memberCount = t.memberCount
        }
      }
    } catch {
      // 复查失败不影响已有结论
    }
  }

  // 队长/续填队伍若没有对应记录（例如续填他人队伍），补一条
  for (const team of allTeams.values()) {
    const hasRecord = result.accounts.some((a) => a.userid === team.leader.userid)
    if (!hasRecord && team.leader) {
      record(
        team.leader,
        team.leader.isLeader ? 'leader' : 'joined',
        '本期已有队伍',
        team,
        team.memberCount,
      )
    }
  }

  result.teams = [...allTeams.values()].map((t) => ({
    code: t.code,
    memberCount: t.memberCount,
    targetMembers: target,
    full: t.memberCount >= target,
  }))
  // 主队伍：人数最多的那支，供通知与网页卡片展示
  const main = result.teams.slice().sort((a, b) => b.memberCount - a.memberCount)[0] || null
  result.team = main

  if (result.teams.length > 1) {
    printBlue(`组队：本期共 ${result.teams.length} 支队伍`)
  }

  for (const a of result.accounts) a.targetMembers = target
  return summarize(result)
}

/** 去重并按 userid 稳定排序，避免同一账号出现两条记录 */
function summarize(result) {
  const seen = new Map()
  for (const a of result.accounts) seen.set(a.userid, a)
  result.accounts = [...seen.values()]
  const count = (role) => result.accounts.filter((a) => a.role === role).length
  result.summary = {
    total: result.accounts.length,
    leader: count('leader'),
    member: count('member'),
    joined: count('joined'),
    failed: count('failed'),
    skipped: count('skipped'),
  }
  return result
}

export { runTeamStage }
