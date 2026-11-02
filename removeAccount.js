// 网页删除账号：Worker 触发本工作流后，这里读出 USERINFO、过滤掉目标 userid 再写回。
// Secret 只写不可读，所以"从列表里摘掉一个"这件事只能在 Actions 里做。
import { printGreen, printMagenta, printRed, printYellow } from './utils/colorOut.js'
import { saveUserinfo } from './utils/userinfo.js'
import { removeRemoteAccount } from './utils/syncState.js'

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
  const target = String(process.env.TARGET_USERID || '').trim()
  if (!target) throw new Error('缺少 TARGET_USERID')

  const userinfo = parseUserinfo()
  const before = userinfo.length
  const next = userinfo.filter((u) => String(u.userid) !== target)

  if (next.length === before) {
    // 幂等：secret 里已经没有这个账号了，照样清一下网页元数据，避免列表里留幽灵行
    printYellow(`USERINFO 中没有 userid ${target}，跳过 secret 写入，仅清理网页列表`)
  } else {
    // 删掉最后一个账号时列表会变成空数组，必须允许写空
    if (!saveUserinfo(next, { allowEmpty: true })) {
      throw new Error('写入 secret USERINFO 失败，请检查 PAT 是否有效且有 Secrets 写权限')
    }
    printMagenta(`已删除 1 个账号，剩余 ${next.length} 个（原 ${before} 个）`)
  }

  await removeRemoteAccount(target)
  printGreen('完成')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    printRed(`删除账号失败：${e.message}`)
    console.log(`::error::${e.message}`)
    process.exit(1)
  })
