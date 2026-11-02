import { execFileSync } from "child_process";

function hasSecretWriteToken() {
  return Boolean(process.env.PAT || process.env.GH_TOKEN);
}

/**
 * 把 gh 的失败信息（含 stderr）整理成可读错误。
 * gh secret set 失败时真正的原因（401 Bad credentials / 403 Resource not accessible）
 * 只在 stderr 里，必须带出来，否则日志只有一句 "Command failed"。
 */
function runGh(args, input) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.PAT;

  if (!repository) {
    throw new Error("GITHUB_REPOSITORY 未配置");
  }
  if (!token) {
    throw new Error("PAT/GH_TOKEN 未配置");
  }

  try {
    return execFileSync("gh", args, {
      input: input === undefined ? undefined : input,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: token,
        // 关掉分页/交互提示，避免在 Actions 里卡住
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : "";
    const stdout = e?.stdout ? String(e.stdout).trim() : "";
    const detail = stderr || stdout || e?.message || String(e);
    const err = new Error(detail);
    err.stderr = stderr;
    err.stdout = stdout;
    err.code = e?.status;
    throw err;
  }
}

function setRepoSecret(name, value) {
  const repository = process.env.GITHUB_REPOSITORY;
  return runGh(["secret", "set", name, "--repo", repository], value);
}

/**
 * 写权限探针：真的往仓库写一个临时 secret 再删掉。
 * 目的：在用户扫码之前就把「PAT 失效 / 没有 Secrets 写权限」暴露出来，
 * 而不是等扫码成功后才发现写不进去（历史 bug：工作流绿了但账号没存上）。
 * @returns {{ok: boolean, detail: string}}
 */
function probeSecretWrite() {
  const repository = process.env.GITHUB_REPOSITORY;
  const probeName = "__KGCHECKIN_PAT_PROBE";
  try {
    runGh(["secret", "set", probeName, "--repo", repository], "probe");
  } catch (e) {
    return { ok: false, detail: e.message };
  }
  try {
    runGh(["secret", "delete", probeName, "--repo", repository]);
  } catch (_) {
    // 删除失败不影响结论，抛给调用方不如忽略
  }
  return { ok: true, detail: "ok" };
}

export { hasSecretWriteToken, setRepoSecret, probeSecretWrite };
