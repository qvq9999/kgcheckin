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
 * @param {{userid: string|number, token: string}} user
 * @returns {string}
 */
function buildTeamCookie(user) {
  const { dfid, mid, uuid } = deriveDevice(user.userid)
  return [
    `token=${user.token}`,
    `userid=${user.userid}`,
    `dfid=${dfid}`,
    `KUGOU_API_MID=${mid}`,
    `uuid=${uuid}`,
  ].join('; ')
}

export { deriveDevice, buildTeamCookie, md5 }
