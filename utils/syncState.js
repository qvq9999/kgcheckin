// 把账号状态同步到网页（Cloudflare Worker 的 KV）。
// 只上报昵称 / userid / 签到状态 / VIP 到期时间，绝不上报 token。
import { printYellow, printGreen } from './colorOut.js'

/**
 * @param {Array<{userid: string|number, nickname?: string, lastCheckin?: string, ok?: boolean, vipExpiry?: string, error?: string}>} accounts
 * @param {'add'|'checkin'} source
 * @returns {Promise<boolean>}
 */
async function syncAccounts(accounts, source = 'checkin') {
  const base = process.env.SYNC_URL
  const token = process.env.SYNC_TOKEN

  if (!base || !token) {
    printYellow('未配置 SYNC_URL / SYNC_TOKEN，跳过网页状态同步（不影响签到）')
    return false
  }
  if (!accounts || !accounts.length) return false

  const url = base.replace(/\/+$/, '') + '/internal/sync'
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source, accounts }),
    })
    if (!resp.ok) {
      const text = await resp.text()
      printYellow(`网页状态同步失败：HTTP ${resp.status} ${text.slice(0, 200)}`)
      return false
    }
    printGreen(`网页状态已同步（${accounts.length} 个账号）`)
    return true
  } catch (e) {
    printYellow(`网页状态同步异常：${e.message}`)
    return false
  }
}

/**
 * 通知网页把某个账号从元数据里删掉。
 * 幂等：网页侧不存在该 userid 时也算成功。
 * @param {string|number} userid
 * @returns {Promise<boolean>}
 */
async function removeRemoteAccount(userid) {
  const base = process.env.SYNC_URL
  const token = process.env.SYNC_TOKEN

  if (!base || !token) {
    printYellow('未配置 SYNC_URL / SYNC_TOKEN，跳过网页元数据清理（不影响删除）')
    return false
  }

  const url = base.replace(/\/+$/, '') + '/internal/remove'
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userid: String(userid) }),
    })
    if (!resp.ok) {
      const text = await resp.text()
      printYellow(`网页元数据清理失败：HTTP ${resp.status} ${text.slice(0, 200)}`)
      return false
    }
    printGreen('网页账号列表已同步删除')
    return true
  } catch (e) {
    printYellow(`网页元数据清理异常：${e.message}`)
    return false
  }
}

export { syncAccounts, removeRemoteAccount }
