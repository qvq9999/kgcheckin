// 酷狗 web 登录接口客户端（Worker 版）。
// 签名规则对齐 api/util/helper.js 的 signatureWebParams()：
//   md5(secret + 排序后的 key=value 串 + secret)
// 参数集合对齐 api/util/request.js 的 createRequest() 默认参数。
import { md5 } from './md5.js'

const APPID = 1005
const SRCAPPID = 2919
const CLIENTVER = 20489
const WEB_SECRET = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'
const BASE = 'https://login-user.kugou.com'

// 设备标识：原实现 dfid 固定为 '-'，mid/uuid 由其派生，因此每次都一样。
const DFID = '-'
const MID = md5(DFID) + md5(DFID).slice(0, 7)
const UUID = md5(DFID + MID)

/**
 * @param {string} path
 * @param {Record<string, string|number>} moduleParams
 */
async function request(path, moduleParams) {
  const clienttime = Math.floor(Date.now() / 1000)
  const params = {
    dfid: DFID,
    mid: MID,
    uuid: UUID,
    appid: APPID,
    clientver: CLIENTVER,
    userid: 0,
    clienttime,
    ...moduleParams,
  }

  const paramsString = Object.keys(params)
    .map((key) => `${key}=${params[key]}`)
    .sort()
    .join('')
  params.signature = md5(`${WEB_SECRET}${paramsString}${WEB_SECRET}`)

  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))

  const resp = await fetch(`${BASE}${path}?${qs.toString()}`, {
    headers: {
      'User-Agent': UA,
      dfid: DFID,
      clienttime: String(clienttime),
      mid: MID,
    },
  })

  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`酷狗接口返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`)
  }
}

/**
 * 生成扫码登录 key
 * @returns {Promise<{key: string, url: string}>}
 */
export async function createQrKey() {
  const res = await request('/v2/qrcode', {
    // 与原实现一致：非 web 类型走 appid 1001
    appid: 1001,
    type: 1,
    plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,
    srcappid: SRCAPPID,
  })

  const key = res?.data?.qrcode
  if (res?.status !== 1 || !key) {
    throw new Error(`获取二维码失败：status=${res?.status} msg=${res?.error_msg || res?.msg || '未知'}`)
  }
  return { key, url: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}` }
}

/**
 * 查询扫码状态
 * 0 过期 / 1 待扫描 / 2 已扫描待确认 / 4 成功（含 userid、token）
 * @param {string} key
 */
export async function checkQrKey(key) {
  const res = await request('/v2/get_userinfo_qrcode', {
    plat: 4,
    appid: APPID,
    srcappid: SRCAPPID,
    qrcode: key,
  })

  const data = res?.data || {}
  return {
    status: data.status,
    userid: data.userid,
    token: data.token,
    nickname: data.nickname,
  }
}
