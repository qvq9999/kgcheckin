/**
 * 用户信息管理工具
 * 提供登录脚本共享的用户信息更新与保存逻辑
 */

import { printBlue, printGreen, printRed, printYellow } from './colorOut.js'
import { hasSecretWriteToken, setRepoSecret } from './githubSecrets.js'
import { maskIdentifier, sanitizeForLog, shouldPrintSensitiveValue } from './safeLog.js'

/**
 * 将登录用户信息更新或追加到 userinfo 数组中
 * @param {Array} userinfo - 用户信息数组
 * @param {{ userid: string|number, token: string }} loginUser - 新登录的用户
 * @param {boolean} append - 是否追加模式（已存在则更新，否则添加）
 * @returns {'added'|'updated'|'skipped'} 本次操作结果
 */
function upsertUser(userinfo, loginUser, append) {
  const userid = String(loginUser.userid ?? '').trim()
  const token = String(loginUser.token ?? '').trim()

  // userid / token 任一缺失都是无效登录，宁可不写也不能污染 USERINFO
  if (!userid || !token) {
    printRed('登录响应缺少 userid 或 token，已跳过该账号')
    return 'skipped'
  }

  if (append) {
    for (const user of userinfo) {
      if (String(user.userid) === userid) {
        printYellow(`userid: ${maskIdentifier(userid)} 此账号已存在, 仅更新登录信息`)
        user.userid = userid
        user.token = token
        return 'updated'
      }
    }
  }
  userinfo.push({ userid, token })
  return 'added'
}

/**
 * 保存 userinfo 到 GitHub Secret，失败时降级为日志输出
 * @param {Array} userinfo - 用户信息数组
 * @param {{allowEmpty?: boolean}} [options] allowEmpty：允许写入空数组（删除最后一个账号时需要）
 * @returns {boolean} 是否成功写入 Secret（降级输出也算未写入）
 */
function saveUserinfo(userinfo, { allowEmpty = false } = {}) {
  if (!userinfo.length && !allowEmpty) {
    printRed('没有可写入的账号信息，跳过 secret <USERINFO> 更新')
    return false
  }
  if (!userinfo.length) {
    printYellow('账号列表已清空，将写入空数组 []（删除最后一个账号）')
  }

  const userinfoJSON = JSON.stringify(userinfo)

  if (!hasSecretWriteToken()) {
    printYellow('PAT/GH_TOKEN 未配置，无法自动写入 secret <USERINFO>')
    printUserinfoFallback(userinfoJSON)
    // 没写入就是失败，交给调用方决定退出码，避免工作流假成功
    console.log(`::error::未配置 PAT/GH_TOKEN，新账号信息未写入 secret <USERINFO>`)
    return false
  }

  try {
    setRepoSecret('USERINFO', userinfoJSON)
    printGreen(`secret <USERINFO> 更改成功（共 ${userinfo.length} 个账号）`)
    return true
  } catch (error) {
    printRed('自动写入 secret <USERINFO> 出错')
    const detail = error?.stderr || error?.message || String(error)
    console.dir(sanitizeForLog({ message: String(detail).slice(0, 2000) }), { depth: null })
    printUserinfoFallback(userinfoJSON)
    // 显式标注 error：工作流会红，且 Summary 能看到原因
    console.log(`::error::写入 secret <USERINFO> 失败，新账号未被保存：${String(detail).slice(0, 500)}`)
    return false
  }
}

/**
 * 降级方案：按配置决定是否在日志中输出 USERINFO
 */
function printUserinfoFallback(userinfoJSON) {
  if (shouldPrintSensitiveValue()) {
    printGreen('登录信息如下，把它添加到secret USERINFO 即可')
    printYellow('注意：日志包含登录 token，请用完后删除 Actions 日志')
    printBlue(userinfoJSON)
  } else {
    printYellow('为避免泄露 token，默认不在日志输出 USERINFO')
    printYellow('如必须手动复制，请重新运行并将 print_userinfo 选择为 是')
  }
}

export { upsertUser, saveUserinfo }
