// GitHub REST 客户端：写仓库 Secret（sealed box 加密）、触发 workflow。
// 不复用 gh CLI —— Workers 里没有可执行文件，必须走 REST。
import sealbox from 'tweetnacl-sealedbox-js'

const API = 'https://api.github.com'

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kgcheckin-web',
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

async function ghJson(url, token, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: { ...headers(token), ...(init.headers || {}) },
  })
  const text = await resp.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!resp.ok) {
    const msg = typeof body === 'object' && body ? body.message : String(body).slice(0, 200)
    throw new Error(`GitHub ${resp.status}: ${msg}`)
  }
  return body
}

/**
 * 写入（或覆盖）仓库 Secret。GitHub 要求用仓库公钥做 sealed box 加密。
 * @param {{token: string, repo: string, name: string, value: string}} opts
 */
export async function setRepoSecret({ token, repo, name, value }) {
  const pk = await ghJson(`${API}/repos/${repo}/actions/secrets/public-key`, token)
  if (!pk?.key || !pk?.key_id) throw new Error('未取到仓库公钥，PAT 可能没有 Actions Secrets 权限')

  const sealed = sealbox.seal(new TextEncoder().encode(value), b64ToBytes(pk.key))

  await ghJson(`${API}/repos/${repo}/actions/secrets/${name}`, token, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value: bytesToB64(sealed), key_id: pk.key_id }),
  })
}

/**
 * 删除仓库 Secret（用于清理临时凭证）。不存在时视为成功。
 */
export async function deleteRepoSecret({ token, repo, name }) {
  const resp = await fetch(`${API}/repos/${repo}/actions/secrets/${name}`, {
    method: 'DELETE',
    headers: headers(token),
  })
  if (resp.ok || resp.status === 404) return true
  const text = await resp.text()
  throw new Error(`GitHub ${resp.status}: ${text.slice(0, 200)}`)
}

/**
 * 触发 workflow_dispatch。
 * @param {{token: string, repo: string, workflow: string, ref?: string, inputs?: Record<string,string>}} opts
 */
export async function dispatchWorkflow({ token, repo, workflow, ref = 'main', inputs = {} }) {
  const resp = await fetch(
    `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, inputs }),
    }
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`触发 workflow 失败（${resp.status}）：${text.slice(0, 200)}`)
  }
}

/**
 * 查询最近一次某 workflow 的运行状态，用于页面显示"处理中/已完成"。
 */
export async function latestRun({ token, repo, workflow }) {
  const body = await ghJson(
    `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=1`,
    token
  )
  const run = body?.workflow_runs?.[0]
  if (!run) return null
  return { id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at }
}
