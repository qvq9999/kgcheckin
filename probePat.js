// PAT 写权限预检：在用户扫码之前确认「登录信息能不能写进 secret USERINFO」。
// 历史故障：PAT 失效/权限不足时 setRepoSecret 失败被吞掉，工作流仍显示成功，
// 用户以为登录成功，实际 USERINFO 从未更新 → 新账号永远加不进去。
import { hasSecretWriteToken, probeSecretWrite } from './utils/githubSecrets.js'
import { printGreen, printRed, printYellow } from './utils/colorOut.js'

function main() {
  if (!hasSecretWriteToken()) {
    printRed('未配置 secret PAT，登录信息无法自动写入 secret USERINFO')
    console.log('::error::缺少 secret PAT。请在仓库 Settings → Secrets and variables → Actions 添加 PAT（需 Secrets 读写权限）')
    process.exit(1)
  }

  const { ok, detail } = probeSecretWrite()
  if (!ok) {
    printRed('PAT 写权限校验失败')
    printYellow(detail)
    console.log(`::error::PAT 无法写入仓库 Secret：${String(detail).slice(0, 500)}`)
    console.log('::error::常见原因：1) 令牌已过期 2) 精细化令牌缺少 Secrets: Read and write 3) 令牌不覆盖本仓库 4) 令牌被撤销')
    process.exit(1)
  }

  printGreen('PAT 写权限校验通过，登录信息可以正常写入 secret USERINFO')
}

main()
