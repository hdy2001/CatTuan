// Pi supplies complete tool arguments and results in its ordered SSE stream.
// Replayed events update existing steps instead of creating duplicates.
export function recordToolEvent(task, event, { labelFor = (name) => name, describe = () => ({}), now = () => new Date().toISOString(), maxSteps = 60 } = {}) {
  if (!['tool.started', 'tool.completed'].includes(event.event) || !event.tool_call_id || !event.tool) return null;
  task.steps ||= [];
  let step = task.steps.find((entry) => entry.id === event.tool_call_id);
  const created = !step;
  if (!step) {
    step = { id: event.tool_call_id, name: event.tool, label: labelFor(event.tool), status: 'running', at: now() };
    task.steps.push(step);
    if (task.steps.length > maxSteps) task.steps.splice(0, task.steps.length - maxSteps);
  }
  // A replayed start cannot turn a completed step back into a running step.
  if (event.event === 'tool.started' && step.status === 'done') return { step, created };
  Object.assign(step, describe(event.tool, event.args || {}, event.event === 'tool.completed' ? event : undefined));
  if (event.event === 'tool.completed') Object.assign(step, { status: 'done', endedAt: step.endedAt || now() });
  return { step, created };
}
