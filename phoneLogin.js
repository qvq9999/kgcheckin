import { printGreen, printRed, printYellow } from "./utils/colorOut.js";
import { sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { upsertUser, saveUserinfo } from "./utils/userinfo.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";

async function login() {

  const phone = process.env.PHONE
  const code = process.env.CODE
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER

  // USERINFO 解析失败要给可读错误，而不是抛 JSON 语法异常
  let userinfo = []
  if (USERINFO && APPEND_USER == "是") {
    try {
      const parsedUserinfo = JSON.parse(USERINFO)
      if (!Array.isArray(parsedUserinfo)) throw new Error('不是数组')
      userinfo = parsedUserinfo
    } catch (e) {
      throw new Error(`secret <USERINFO> 内容不是合法 JSON 数组，无法追加账号：${e.message}`)
    }
  }

  // 不使用二维码登录并且没有手机号或验证码
  if (!phone || !code) {
    throw new Error("未配置")
  }
  // 启动服务并等待就绪（避免冷启动竞态）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  try {
    // 手机号登录请求
    const result = await send(`/login/cellphone?mobile=${phone}&code=${code}`, "GET", {})
    if (result.status === 1) {
      printGreen("登录成功！")
      const action = upsertUser(userinfo, { userid: result.data.userid, token: result.data.token }, APPEND_USER == "是")
      if (action === 'skipped') {
        console.error('::error::登录响应缺少 userid 或 token，未写入 USERINFO')
        process.exit(2)
      }
      if (!saveUserinfo(userinfo)) {
        console.error('::error::账号信息未能写入 secret <USERINFO>，请检查 PAT 是否有效且有 Secrets 写权限')
        process.exit(2)
      }
    } else if (result.error_code === 34175) {
      throw new Error("暂不支持多账号绑定手机登录")
    } else {
      printRed("响应内容")
      console.dir(summarizeResponse(result), { depth: null })
      throw new Error("登录失败！请检查")
    }
  } finally {
    close_api(api)
  }
}

login().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
