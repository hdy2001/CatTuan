// App 的全部配置：环境变量优先，其次是仓库 agent-home/.env（大家共用的模型 key、代理）。只在这里读一次。
// 线上的环境变量在 /etc/cattuan.env（deploy/setup.sh 生成）。
import path from 'node:path';
import { TEMPLATE, dataDir } from './homes.mjs';
import { readEnv } from './tools/common.mjs';

const LONGCAT_URL = 'https://api.longcat.chat/openai/v1';

export function loadConfig(processEnv = process.env) {
  const env = { ...readEnv(path.join(TEMPLATE, '.env')), ...processEnv };
  const num = (key, fallback) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    const n = Number(env[key]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    return n;
  };
  const publicOrigin = (env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  const secure = publicOrigin.startsWith('https://');
  const longcatKey = env.LONGCAT_API_KEY || '';
  return {
    env,
    dataDir: dataDir(),
    port: num('PORT', 3210),
    host: env.HOST || '127.0.0.1', // 线上也只听本机，由 Caddy 反代出去
    publicOrigin,
    secure,
    // 调试用的注册接口：本机（非 HTTPS）默认开，线上默认关
    allowRegister: env.ALLOW_REGISTER ? env.ALLOW_REGISTER === '1' : !secure,
    sandboxUrl: env.CATTUAN_SANDBOX_URL || 'http://127.0.0.1:8660',
    // 普通成员每天的用量上限（管理员不限）：大家共用一个模型 key
    quota: {
      messages: num('QUOTA_MESSAGES_PER_DAY', 300),
      tasks: num('QUOTA_TASKS_PER_DAY', 40),
      goalChecks: num('QUOTA_GOAL_CHECKS_PER_DAY', 48),
      goals: num('QUOTA_GOALS', 5),
      goalMinEvery: num('QUOTA_GOAL_MIN_EVERY', 60),
    },
    // 主 agent（聊天）要快、要能看图；子 agent（后台任务、目标检查）可以慢一点、多做几步
    models: {
      main: {
        id: env.DISPATCH_MODEL || 'LongCat-2.5-Preview', url: env.DISPATCH_API_URL || LONGCAT_URL, key: env.DISPATCH_API_KEY || longcatKey,
        maxTurns: num('DISPATCH_MAX_TURNS', 10), maxTokens: num('DISPATCH_MAX_TOKENS', 1024), contextWindow: num('PI_CONTEXT_WINDOW', 128000),
      },
      worker: {
        id: env.PI_MODEL || 'LongCat-2.5-Preview', url: env.PI_API_URL || LONGCAT_URL, key: env.PI_API_KEY || longcatKey,
        maxTurns: num('PI_MAX_TURNS', 90), maxTokens: num('PI_MAX_TOKENS', 8192), contextWindow: num('PI_CONTEXT_WINDOW', 128000),
      },
    },
  };
}
