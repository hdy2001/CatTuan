// 主 agent（聊天里的喵团）的聊天专用工具：派子 agent、改 / 停子 agent、提问卡、目标。干活的工具（搜索、读网页、
// 搜图、看图、记忆……）和子 agent 是同一套（pi-tools.mjs），由 dispatcher.mjs 合进来。这些工具都在 App 进程里直接改这个人的状态；
// App 的函数由 server.mjs 注入（actions），这里只管参数校验、额度和这一轮要挂到回复上的东西（turn.attach）。
//
// 「说过话就结束这一轮」：主 agent 通常先回一句话、同时调一个办事的工具。这一轮已经说过话时，办事工具的结果带 terminate，
// Pi 不再为这个结果多请求一次模型；没说过话就让模型接着说一句。查东西的工具（看任务结果）不结束这一轮。

const text = (s, terminate = false) => ({ content: [{ type: 'text', text: String(s) }], details: {}, terminate });
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const CATEGORY = { type: 'string', enum: ['life', 'work', 'coding', 'social'], description: '任务列表上的图标：life 生活（吃喝玩乐、出行、天气、购物、健康、提醒、打电话订位）、work 工作学习（调研、报告、行业公司、新闻、写东西）、coding 编程、social 社交（朋友家人、送礼、聚会、追星）' };
const STRING = { type: 'string' };

export function createDispatcherTools({ u, chatId, turn, actions }) {
  const done = (s) => text(s, turn.spoke === true);
  const findTask = (id) => actions.tasks(u).find((t) => t.id === String(id || '') && t.kind !== 'goal');
  const did = (s) => { turn.did.push(s); };

  // 派子 agent：App 把这个聊天到现在的会话复制一份给它（forkChat），它看得到前面聊的、查到的、用户发的图
  function dispatchTask({ title, brief, category, research }) {
    const over = actions.overQuota(u, 'tasks');
    if (over) return text(`没派出去：${over}（把这句话告诉用户）`);
    const t = actions.createTask(u, { title: str(title, 20) || '后台任务', brief, kind: research ? 'research' : 'chat',
      chatId, category, query: turn.userText, forkChat: chatId });
    Object.assign(turn.attach, { taskId: t.id, round: 1 });
    did(`派出${t.kind === 'research' ? '深度搜索' : '子 agent'}「${t.title}」`);
    return done(`已派出子 agent ${t.id}「${t.title}」，排队中。结果出来后会发给你，由你告诉用户。`);
  }

  const tools = [
    {
      name: 'subagent', label: '派子 agent',
      description: '派一个子 agent 在后台做复杂的事：打电话（只有子 agent 能打）、深度调研、要读很多网页或挨个查很多家、要好几分钟的事。子 agent 是你的分身：带着你们到现在的完整对话，工具和你一样，还能打电话。它做完把结果交回给你，由你告诉用户。一两步能办完的事自己办，不要派。同一件事已经有子 agent 在跑或排队，不要重复派。',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: '不超过 12 个字' },
        task: { type: 'string', description: '这次让它做什么、做到什么程度、交回什么。聊天里说过的不用复述（它都看得到），写「打给刚才那家」「结果里的第 3 家」就行' },
        category: CATEGORY,
        research: { type: 'boolean', description: '要全面查清楚、调研、对比、找途径时写 true（深度搜索，出研究报告）' },
      }, required: ['title', 'task'] },
      async execute(_id, args) {
        const brief = str(args?.task, 4000);
        if (!brief) return text('task 不能为空');
        return dispatchTask({ title: args.title, brief, category: args.category, research: args.research === true });
      },
    },
    {
      name: 'steer_task', label: '改任务',
      description: '用户在对某个排队中、进行中或刚结束的子 agent 任务提修改（不要…、换成…、再加上…、这个不好、重做一下）时用，不要派新的。进行中的会被插话调整，做完的会在原任务上接着改一轮。目标检查不能改。',
      parameters: { type: 'object', properties: {
        task_id: { type: 'string' },
        instruction: { type: 'string', description: '怎么改，完整、脱离聊天也能看懂；只写用户这次说的修改' },
      }, required: ['task_id', 'instruction'] },
      async execute(_id, args) {
        const t = findTask(args?.task_id);
        if (!t) return text(`没有这个任务：${args?.task_id}。看【后台任务】里的 id`);
        const rev = await actions.steerTask(t, str(args.instruction, 500));
        if (!rev) return text('没改成：修改内容是空的');
        Object.assign(turn.attach, { steerOf: t.id, round: rev.round });
        did(`让「${t.title}」${rev.state === 'round' ? `开第 ${rev.round} 轮改` : '按新要求调整'}`);
        return done(rev.state === 'round' ? `「${t.title}」会接着改一轮（第 ${rev.round} 轮）` : `已把修改交给「${t.title}」`);
      },
    },
    {
      name: 'stop_task', label: '停任务',
      description: '用户说别弄了、不用了、先停一下时，停掉那个排队中或进行中的任务。',
      parameters: { type: 'object', properties: { task_id: STRING }, required: ['task_id'] },
      async execute(_id, args) {
        const t = findTask(args?.task_id);
        if (!t) return text(`没有这个任务：${args?.task_id}`);
        if (!actions.stopTask(t)) return text(`「${t.title}」已经结束了，不用停`);
        Object.assign(turn.attach, { stopOf: t.id, round: t.round || 1 });
        did(`停了「${t.title}」`);
        return done(`已停掉「${t.title}」`);
      },
    },
    {
      name: 'read_task_result', label: '看任务结果',
      description: '读一个任务的完整结果（报告全文、清单、每通电话的结果）。用户问到你上下文里没有的细节时用；结果里有的直接照着答，不用再搜、不派任务。',
      parameters: { type: 'object', properties: { task_id: STRING }, required: ['task_id'] },
      async execute(_id, args) {
        const t = actions.tasks(u).find((x) => x.id === String(args?.task_id || ''));
        return text(t ? actions.taskResult(t) : `没有这个任务：${args?.task_id}`);
      },
    },
    {
      name: 'ask_user', label: '出提问卡',
      description: '缺信息时出一张提问选项卡，一次问清缺的几项（最多 4 题，每题 2–4 个短选项，推荐的放第一个）。同时用一句话说还差什么。',
      parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: {
        tab: { type: 'string', description: '不超过 6 个字' }, label: { type: 'string', description: '问题' },
        options: { type: 'array', items: STRING },
      }, required: ['label', 'options'] } } }, required: ['questions'] },
      async execute(_id, args) {
        const ask = actions.normAsk(args);
        if (!ask) return text('没出成：每题要有问题和至少 2 个选项');
        turn.attach.booking = ask;
        did('出了提问卡');
        return done('提问卡会挂在你这条回复下面');
      },
    },
    {
      name: 'create_goal', label: '建目标',
      description: '用户想长期持续关注某件事（帮我盯着…、以后每天…、有新的就告诉我）时建一个目标，它会定期自动检查，有新进展时主动告诉用户。【目标】里已有同类的就不要重复建。',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: '不超过 12 个字' },
        brief: { type: 'string', description: '每次检查做什么、关注谁、什么算新进展' },
        schedule: { type: 'object', description: '{"every": 分钟数} 或 {"at": "HH:MM"}；没说频率就 {"every": 360}', properties: { every: { type: 'number' }, at: STRING } },
      }, required: ['title', 'brief'] },
      async execute(_id, args) {
        const brief = str(args?.brief, 2000);
        if (!brief) return text('brief 不能为空');
        const over = actions.goalLimit(u);
        if (over) return text(`没建成：${over}（把这句话告诉用户）`);
        const g = actions.createGoal(u, { title: str(args.title, 20) || '新目标', brief, schedule: args.schedule });
        turn.attach.goalId = g.id;
        did(`建了目标「${g.title}」`);
        return done(`已建目标 ${g.id}「${g.title}」，马上先查一次`);
      },
    },
    {
      name: 'complete_goals', label: '完成目标',
      description: '用户说某个目标办完了、不用再盯 / 不用再提醒了时，把【目标】里对应的目标标成完成。分不清是哪个就先问一句。',
      parameters: { type: 'object', properties: { goal_ids: { type: 'array', items: STRING } }, required: ['goal_ids'] },
      async execute(_id, args) {
        const ids = new Set([].concat(args?.goal_ids || []).map(String));
        const goals = actions.goals(u).filter((g) => ids.has(g.id) && !g.done);
        if (!goals.length) return text('没有这些进行中的目标，看【目标】里的 id');
        for (const g of goals) { actions.setGoalDone(g); did(`完成目标「${g.title}」`); }
        return done(`已完成：${goals.map((g) => g.title).join('、')}`);
      },
    },
  ];
  return tools;
}
