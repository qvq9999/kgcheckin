// 网页快捷添加账号：页面触发 workflow 后，本脚本从 Worker 一次性领取扫码凭证，
// 合并进 USERINFO。Secret 不可读，追加动作只能发生在 Actions 里（这里有明文）。
import fs from 'node:fs'
import { printGreen, printMagenta, printRed, printYellow } from './utils/colorOut.js'
import { upsertUser, saveUserinfo } from './utils/userinfo.js'
import { syncAccounts } from './utils/syncState.js'

const PENDING_FILE = process.env.PENDING_FILE || './pending.json'

function parseUserinfo() {
  const raw = process.env.USERINFO
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    printYellow(`USERINFO 不是合法 JSON，按空列表处理：${e.message}`)
    return []
  }
}

async function main() {
  if (!fs.existsSync(PENDING_FILE)) {
    throw new Error(`未找到待添加凭证文件 ${PENDING_FILE}（领取步骤可能失败）`)
  }

  let cred
  try {
    cred = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
  } catch {
    throw new Error('待添加凭证不是合法 JSON')
  } finally {
    // 无论成败都删掉本地临时文件，避免凭证残留在 runner 里
    try { fs.unlinkSync(PENDING_FILE) } catch { /* 忽略 */ }
  }

  const userid = String(cred.userid || '').trim()
  const token = String(cred.token || '').trim()
  if (!userid || !token) throw new Error('凭证缺少 userid 或 token')

  const userinfo = parseUserinfo()
  const before = userinfo.length

  // 网页端新增一律按追加处理：已存在则更新 token，不会覆盖其他账号
  const action = upsertUser(userinfo, { userid, token }, true)
  if (action === 'skipped') throw new Error('凭证无效，未写入')

  if (!saveUserinfo(userinfo)) {
    throw new Error('写入 secret USERINFO 失败，请检查 PAT 是否有效且有 Secrets 写权限')
  }

  // 同步元数据给网页（不含 token）
  await syncAccounts([{ userid, nickname: cred.nickname || '' }], 'add')

  // 把 userid 交给下一步（立即签到该账号）使用
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `userid=${userid}\n`)
  }

  // 同时把合并后的完整列表写成文件：同一个 job 内 secrets.USERINFO 不会刷新，
  // 下一步只能靠文件拿到包含新账号的列表。
  const outFile = process.env.USERINFO_OUT_FILE || './userinfo.json'
  fs.writeFileSync(outFile, JSON.stringify(userinfo), { mode: 0o600 })
  printGreen(`已写出账号列表到 ${outFile}，供下一步单账号签到使用`)

  const label = action === 'added' ? '新增' : '更新'
  printMagenta(`账号${label}成功：${cred.nickname || '(未返回昵称)'}，当前共 ${userinfo.length} 个账号（原 ${before} 个）`)
  printGreen('完成')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    printRed(`快捷添加失败：${e.message}`)
    console.log(`::error::${e.message}`)
    process.exit(1)
  })
