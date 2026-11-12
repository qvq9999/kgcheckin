// 设备指纹派生
//
// 背景：酷狗的组队接口（/team/*）直接从 cookie 里读 dfid / KUGOU_API_MID / uuid，
// 缺失时回落成 '-' / '' / '-'，会让签名不合格。而签到流程原先只传 token + userid。
//
// 设计取舍：**确定性派生**，不落库。
//  - 按 userid 派生，同一账号每次运行得到完全相同的一套指纹（酷狗按设备维度风控，
//    指纹抖动等同于频繁换设备，反而更容易触发 143005「每台设备只能加入一个队伍」）。
//  - 不同账号派生结果不同（多账号互填的必要条件，见 main.js 组队阶段）。
//  - 不需要改 USERINFO 结构，老仓库升级时无需迁移 secret。
//
// 派生规则与 api/util/request.js 保持一致：
//   mid  = md5(dfid) + md5(dfid).slice(0, 7)
//   uuid = md5(dfid + mid)
import { createHash } from 'node:crypto'

const md5 = (s) => createHash('md5').update(String(s)).digest('hex')

/**
 * 为账号派生一套稳定的设备指纹。
 * @param {string|number} userid 酷狗 userid
 * @returns {{dfid: string, mid: string, uuid: string}}
 */
function deriveDevice(userid) {
  const uid = String(userid || '').trim()
  if (!uid) throw new Error('deriveDevice: userid 不能为空')

  const dfid = md5(`kgcheckin:${uid}`)
  const h = md5(dfid)
  const mid = `${h}${h.slice(0, 7)}`
  const uuid = md5(`${dfid}${mid}`)
  return { dfid, mid, uuid }
}

/**
 * 构造组队接口需要的 cookie 串。
 * team_* 模块读取 params.cookie 里的 token / userid / dfid / KUGOU_API_MID / uuid。
 *
 * @param {{userid: string|number, token: string}} user
 * @param {'derived'|'dash'|'none'} [mode]
 *   derived — 派生指纹（默认，保证多账号互不相同）
 *   dash    — 与签到请求一致，dfid 回落成 '-'（模块内部默认）
 *   none    — 只带 token + userid，设备字段全部交给模块默认值
 * @returns {string}
 */
function buildTeamCookie(user, mode = 'derived') {
  if (mode === 'none') return `token=${user.token}; userid=${user.userid}`
  if (mode === 'dash') return `token=${user.token}; userid=${user.userid}; dfid=-`

  const { dfid, mid, uuid } = deriveDevice(user.userid)
  // flat：dfid 用 '-'（与 token 签发设备一致），但 mid/uuid 保持完整，
  // 避免签名缺项。用于期次这类「只看参数完整性、不校验登录态」的接口。
  if (mode === 'flat') {
    return [
      `token=${user.token}`,
      `userid=${user.userid}`,
      'dfid=-',
      `KUGOU_API_MID=${mid}`,
      `uuid=${uuid}`,
    ].join('; ')
  }
  return [
    `token=${user.token}`,
    `userid=${user.userid}`,
    `dfid=${dfid}`,
    `KUGOU_API_MID=${mid}`,
    `uuid=${uuid}`,
  ].join('; ')
}

export { deriveDevice, buildTeamCookie, md5 }
