// 普通成员的每日额度（管理员不限）：超了返回一句给用户看的话，没超返回 ''。
const WHAT = { messages: '条消息', tasks: '个后台任务', goalChecks: '次目标检查' };

export function createQuota({ accounts, limits }) {
  return {
    over(u, kind) {
      if (u.role === 'admin') return '';
      const limit = limits[kind];
      return accounts.usage(u.id, kind) >= limit ? `今天的额度用完啦（每天 ${limit} ${WHAT[kind]}），明天再来～` : '';
    },
    bump: (u, kind) => accounts.bumpUsage(u.id, kind),
    // 同时盯着的目标数
    goalLimit(u) {
      if (u.role === 'admin') return '';
      const n = u.state.goals.filter((g) => !g.done).length;
      return n >= limits.goals ? `最多同时盯 ${limits.goals} 个目标哦，先完成或删掉一个再加～` : '';
    },
    // 目标最短几分钟查一次
    minEvery: (u) => (u.role === 'admin' ? 15 : limits.goalMinEvery),
  };
}
