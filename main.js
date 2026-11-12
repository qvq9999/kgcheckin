import fs from "node:fs";
import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { syncAccounts } from "./utils/syncState.js";
import { runTeamStage } from "./utils/teamStage.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";

async function main() {

  const USERINFO = process.env.USERINFO
  // 优先用文件：Actions 里 secrets 在任务开始时就固定了，
  // 同一个 job 内刚写入的新账号不会出现在后续步骤的 secrets.USERINFO 中，
  // 因此上一步会把合并后的完整列表落到文件里传进来。
  const USERINFO_FILE = process.env.USERINFO_FILE
  let rawUserinfo = USERINFO
  if (USERINFO_FILE) {
    try {
      rawUserinfo = fs.readFileSync(USERINFO_FILE, 'utf8')
      printMagenta(`从文件读取账号列表：${USERINFO_FILE}`)
    } catch (e) {
      throw new Error(`读取 USERINFO_FILE 失败：${e.message}`)
    }
  }
  // 刷新token
  let needRefresh = false
  if (!rawUserinfo) {
    throw new Error("未配置")
  }
  // allUsers 用于回写 USERINFO（必须是完整列表），users 是本次要处理的账号。
  // ONLY_USERID 存在时只处理该账号：网页新增账号后立刻签到，且不影响其他账号。
  const allUsers = JSON.parse(rawUserinfo)
  if (!Array.isArray(allUsers)) throw new Error("USERINFO 不是数组")

  const onlyUserId = String(process.env.ONLY_USERID || '').trim()
  let users = allUsers
  if (onlyUserId) {
    users = allUsers.filter((u) => String(u.userid) === onlyUserId)
    if (!users.length) {
      throw new Error(`USERINFO 中找不到 userid=${onlyUserId}`)
    }
    printMagenta(`单账号模式：只处理 userid ${maskIdentifier(onlyUserId)}（共 ${allUsers.length} 个账号）`)
  }

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  const today = new Date();
  // 服务器时间比国内慢8小时
  today.setTime(today.getTime() + 8 * 60 * 60 * 1000)
  //日期
  const DD = String(today.getDate()).padStart(2, '0'); // 获取日
  const MM = String(today.getMonth() + 1).padStart(2, '0'); //获取月份，1 月为 0
  const yyyy = today.getFullYear(); // 获取年份
  const date = yyyy + '-' + MM + '-' + DD

  const errorMsg = {}
  // 通知结果收集
  const notifyResults = []
  // 网页端账号元数据（不含 token），签到结束后统一上报
  const syncList = []
  // 组队阶段用：只收集签到成功的账号（token 有效），互填队伍时按此顺序处理
  const teamUsers = []
  let teamResult = null
  let hasError = false

  try {
    // 开始签到
    for (const user of users) {
      // 单账号异常隔离：任何一个账号的请求/解析出错，只记录该账号失败，
      // 不影响其余账号继续执行，也保证后续通知与 secret 刷新一定能触发。
      try {
        let headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers)
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid)
          printRed(`token过期或账号不存在, userid: ${safeUserId}`)
          errorMsg[safeUserId] = {
            msg: `token过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail)
          }
          notifyResults.push({
            nickname: safeUserId,
            status: '失败',
            listen: '账号不存在',
            vipClaim: '0/8',
            vipExpiry: '未知',
            error: 'token过期或账号不存在'
          })
          syncList.push({ userid: user.userid, lastCheckin: date, ok: false, error: 'token过期或账号不存在' })
          hasError = true
          continue
        }
        const safeNickname = maskDisplayName(userDetail.data.nickname)
        printMagenta(`账号 ${safeNickname} 开始领取VIP...`)

        // 周日刷新token
        if (today.getDay() === 0) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers)
          if (refreshToken?.status == 1) {
            if (refreshToken?.data?.token !== user.token) {
              needRefresh = true
              printYellow(`账号 ${safeNickname} 需要刷新token`)
              user.token = refreshToken.data.token
              // 用新 token 重建本次请求的 headers，使后续听歌/VIP 领取使用刷新后的凭证
              headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
            }
          }
        }

        // 开始听歌
        printYellow(`开始听歌领取VIP...`)
        // 听歌获取vip
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers)

        let listenStatus = '未知'
        if (listen.status === 1) {
          printGreen("听歌领取成功")
          listenStatus = '成功'
        } else if (listen.error_code === 130012) {
          printGreen("今日已领取")
          listenStatus = '今日已领取'
        } else {
          errorMsg[`${safeNickname} listen`] = summarizeResponse(listen)
          printRed("听歌领取失败")
          listenStatus = '失败'
          hasError = true
        }

        printYellow("开始领取VIP...")
        let claimCount = 0
        let claimTotal = 0
        // 今天已经领过 / 次数用完，属于"正常状态"，不是失败
        let quotaExhausted = false
        for (let i = 1; i <= 8; i++) {
          // ad获取vip
          const ad = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers)
          claimTotal = i
          if (ad.status === 1) {
            printGreen(`第${i}次领取成功`)
            claimCount++
            if (i != 8) {
              await delay(30 * 1000)
            }
          } else if (ad.error_code === 30002) {
            printGreen("今天次数已用光")
            quotaExhausted = true
            break
          } else {
            printRed(`第${i}次领取失败`)
            errorMsg[`${safeNickname} ad`] = summarizeResponse(ad)
            hasError = true
            break
          }
        }

        let vipExpiry = '未知'
        const vip_details = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
        if (vip_details.status === 1 && Array.isArray(vip_details.data?.busi_vip) && vip_details.data.busi_vip.length > 0) {
          vipExpiry = vip_details.data.busi_vip[0].vip_end_time
          printBlue(`今天是：${date}`)
          printBlue(`VIP到期时间：${vipExpiry}\n`)
        } else {
          printRed("获取失败\n")
          errorMsg[`${safeNickname} vip_details`] = summarizeResponse(vip_details)
          hasError = true
        }

        // 今天已领过（听歌接口返回"今日已领取"或领取接口返回"次数已用光"）都算正常完成，
        // 只是本次没有新增领取数，不能记成失败。
        const alreadyDone = listenStatus === '今日已领取' || quotaExhausted
        const accountOk = listenStatus !== '失败' && (claimCount > 0 || alreadyDone)

        notifyResults.push({
          nickname: safeNickname,
          status: accountOk ? '成功' : '部分失败',
          listen: listenStatus,
          vipClaim: alreadyDone && claimCount === 0 ? '今日已领' : `${claimCount}/${claimTotal}`,
          vipExpiry,
          error: ''
        })

        syncList.push({
          userid: user.userid,
          nickname: userDetail.data.nickname,
          lastCheckin: date,
          ok: accountOk,
          // note=already 表示今天早就领过了，页面显示"今日已领"而不是失败
          note: alreadyDone && claimCount === 0 ? 'already' : '',
          vipExpiry: vipExpiry === '未知' ? '' : vipExpiry,
        })

        // 组队阶段只处理登录态有效的账号；user.token 可能已被周日刷新流程更新
        teamUsers.push({
          userid: String(user.userid),
          token: user.token,
          nickname: userDetail.data.nickname,
        })
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || '未知')
        printRed(`账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`)
        errorMsg[safeUserId] = { msg: '处理异常', error: err && err.message ? err.message : String(err) }
        notifyResults.push({
          nickname: safeUserId,
          status: '失败',
          listen: '异常',
          vipClaim: '0/8',
          vipExpiry: '未知',
          error: err && err.message ? err.message : String(err)
        })
        syncList.push({ userid: user.userid, lastCheckin: date, ok: false, error: '处理异常' })
        hasError = true
        continue
      }
    }

    // ---------- 组队阶段 ----------
    // 必须在 api 服务关闭前执行。任何异常都不能影响签到结果，也不能阻断后续通知。
    if (teamUsers.length > 0) {
      try {
        printBlue(`开始组队（${teamUsers.length} 个账号）...`)
        teamResult = await runTeamStage(teamUsers)
      } catch (e) {
        const msg = e && e.message ? e.message : String(e)
        printYellow(`组队阶段异常：${msg}`)
        teamResult = { period: null, accounts: [], team: null, error: '组队阶段异常' }
      }
    }

  } finally {
    close_api(api)
  }

  // 组队结果并入网页元数据：每个账号只带自己的角色与队伍码，不留 token
  // 只要本期确实跑过组队阶段（period 有效），未参与的账号也写 null，
  // 避免上一期的队伍状态残留在页面上被误读成本期结果。
  if (teamResult && teamResult.period) {
    const byUid = new Map((teamResult.accounts || []).map((a) => [String(a.userid), a]))
    for (const item of syncList) {
      const t = byUid.get(String(item.userid))
      if (!t) {
        item.team = null
        continue
      }
      item.team = {
        role: t.role,
        code: t.teamCode || '',
        memberCount: t.memberCount || 0,
        targetMembers: t.targetMembers || 0,
        note: t.note || '',
        periodId: teamResult.period.periodId || '',
        periodName: teamResult.period.periodName || '',
      }
    }
  }

  // 上报账号元数据给网页（不含 token）。失败只提示，绝不影响签到结果
  try {
    await syncAccounts(syncList, 'checkin')
  } catch (e) {
    printYellow(`网页状态同步异常：${e.message}`)
  }

  // 更新secret <USERINFO>（始终用完整账号列表 allUsers，避免单账号模式把其他账号写没了）
  let secretError = null
  if (needRefresh) {
    if (hasSecretWriteToken()) {
      const userinfoJSON = JSON.stringify(allUsers)
      try {
        setRepoSecret("USERINFO", userinfoJSON)
        printGreen("secret <USERINFO> token刷新成功")
      } catch (error) {
        printRed("token刷新失败")
        console.dir(sanitizeForLog({ message: error.message }), { depth: null })
        secretError = new Error("secret <USERINFO> token刷新失败")
      }
    } else {
      printYellow("存在账号需要刷新token，但是未配置PAT，未刷新token最多两个月后过期")
    }
  }

  // 构建通知内容（放在 secret 更新之后、错误抛出之前，确保始终执行）
  const title = `酷狗签到${hasError ? '异常' : '成功'} ${date}`
  let content = `📅 日期: ${date}\n`
  content += `📊 账号数: ${notifyResults.length}\n`
  const successCount = notifyResults.filter(r => r.status === '成功').length
  const failCount = notifyResults.length - successCount
  content += `✅ 成功: ${successCount}  ❌ 失败: ${failCount}\n`

  for (const r of notifyResults) {
    content += `\n【${r.nickname}】\n`
    content += `  🎵 听歌领取: ${r.listen}\n`
    content += `  🎁 VIP领取: ${r.vipClaim} 次\n`
    content += `  ⏰ VIP到期: ${r.vipExpiry}\n`
    if (r.error) {
      content += `  ⚠️ 错误: ${r.error}\n`
    }
  }

  // 组队摘要
  if (teamResult) {
    const s = teamResult.summary || {}
    const doneCount = (s.leader || 0) + (s.member || 0) + (s.joined || 0)
    if (teamResult.team) {
      const t = teamResult.team
      content += `\n🏆 组队: ${t.memberCount}/${t.targetMembers}${t.full ? '（已满员）' : ''}\n`
      content += `   队伍码: ${t.code}\n`
      content += `   已组队账号: ${doneCount} 个\n`
      if (teamResult.teams && teamResult.teams.length > 1) {
        content += `   本期共 ${teamResult.teams.length} 支队伍\n`
      }
    } else if (teamResult.error) {
      content += `\n🏆 组队: 跳过（${teamResult.error}）\n`
    } else {
      content += `\n🏆 组队: 本期无可操作\n`
    }
    const failedTeams = (teamResult.accounts || []).filter((a) => a.role === 'failed')
    for (const a of failedTeams) {
      content += `   ⚠️ ${a.nickname || a.userid}: ${a.note}\n`
    }
  }

  // 发送通知（确保即使 secret 更新失败也能发出）
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  if (Object.keys(errorMsg).length > 0) {
    printRed("异常信息如下:")
    console.dir(sanitizeForLog(errorMsg), { depth: null })
    throw new Error("领取异常")
  }

  if (secretError) {
    throw secretError
  }

}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
