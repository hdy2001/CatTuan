// 木星 CLI 的鉴权。CLI 每次执行都自己调 mtsso-moa-local-exchange 换 SSO token（要本机登录 MOA）。
// 要从外面给凭据时，把 bin/ 里同名的小脚本放到 CLI 的 PATH 最前面：CLI 换票时拿到的就是我们给的 token。
// JUPITER_AUTH 选取票方式（默认 moa）；加一种方式 = 在 SOURCES 里加一个 (env, signal) → token 的函数。
// env 是工具的 ctx.env：全局配置（/etc/cattuan.env、agent-home/.env），再叠上这个账号 home/.env 里的覆盖。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');

export class AuthError extends Error {}

// 跑一条 shell 命令，stdout 就是 token（公司的换票脚本、密钥管理工具……都能包进来）
function command(env, signal) {
  if (!env.JUPITER_AUTH_COMMAND) throw new AuthError('JUPITER_AUTH=command 但没配 JUPITER_AUTH_COMMAND');
  return new Promise((ok, fail) => {
    execFile('/bin/sh', ['-c', env.JUPITER_AUTH_COMMAND], { signal, timeout: 15000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error?.name === 'AbortError') return fail(signal?.reason ?? error);
      if (error) return fail(new AuthError(`取 token 的命令失败：${String(stderr || error.message).trim().slice(0, 200)}`));
      ok(stdout.trim());
    });
  });
}

// null：不替 CLI 取票（它自己用本机 MOA 换）
const SOURCES = {
  moa: async () => null,
  token: async (env) => env.JUPITER_SSO_TOKEN,
  command,
};

// → 跑 CLI 用的环境变量：以 App 进程的环境为底（MOA 换票要用 PATH、HOME），只加鉴权要的；模型 key 这些配置不传给 CLI。
// 去掉 HTTP(S)_PROXY：那是给沙箱访问国外网站用的，CLI 只连公司内网，走它会 502
export async function cliEnv(env = {}, signal) {
  const kind = env.JUPITER_AUTH || 'moa';
  const source = Object.hasOwn(SOURCES, kind) ? SOURCES[kind] : null;
  if (!source) throw new AuthError(`不认识的 JUPITER_AUTH：${kind}（可选 ${Object.keys(SOURCES).join(' / ')}）`);
  const token = await source(env, signal);
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)));
  if (token === null) return base;
  if (!token) throw new AuthError(`JUPITER_AUTH=${kind} 没拿到 token`);
  return { ...base, PATH: [SHIM_DIR, base.PATH].filter(Boolean).join(path.delimiter), CATTUAN_SSO_TOKEN: token };
}
