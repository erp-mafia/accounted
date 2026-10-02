import { EXIT, UnavailableError } from '../errors.mjs'
import { classifyToolResult, isTaskDone, pollInterval } from '../mcp.mjs'

/**
 * Print a tools/call result and return the exit code. A task handle is polled
 * to the end first; the task id is printed before the first wait so an agent
 * whose shell call times out can resume with `accounted task <id>`.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {Record<string, any>} result
 */
export async function settle(ctx, result) {
  let outcome = classifyToolResult(result)
  if (outcome.kind === 'task') {
    outcome = classifyToolResult(await waitForTask(ctx, outcome.task))
  }

  if (outcome.kind === 'error') {
    ctx.err({ error: outcome.error })
    return EXIT.TOOL_ERROR
  }

  ctx.out(outcome.data)
  const company = /** @type {Record<string, any> | undefined} */ (outcome.company)
  if (company && typeof company === 'object') {
    ctx.note(`Company: ${company.name ?? ''} (${company.id ?? company.company_id ?? 'unknown id'})`.trim())
  }
  const data = /** @type {Record<string, any> | null} */ (outcome.data)
  if (data && typeof data === 'object' && data.staged === true) {
    ctx.note(stagedNote(ctx, data))
  }
  return EXIT.OK
}

/**
 * The staged answer names the approve call; repeat it as a command. For a
 * high-risk operation the server leaves `confirmed` out on purpose: it is
 * added only after the user has acknowledged that the posting is
 * irreversible, so the CLI says that instead of adding it.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {Record<string, any>} data
 */
function stagedNote(ctx, data) {
  const lines = [
    `Staged for approval: operation ${data.operation_id ?? '(id in the output)'}${data.risk_level ? `, risk ${data.risk_level}` : ''}. Nothing is booked yet.`,
  ]
  const approve = data.approve
  if (approve && typeof approve.tool === 'string') {
    const tool = approve.tool.replace(/^(accounted|gnubok)_/, '')
    lines.push(`When the user approves it, run: accounted call ${tool} '${JSON.stringify(approve.args ?? {})}'`)
  }
  if (data.risk_level === 'high') {
    lines.push(
      'High risk: irreversible once approved (BFL 5 kap 5 §). Show the user the preview, get an explicit acknowledgment, and only then add "confirmed": true to the approve arguments.'
    )
  }
  lines.push(`Or approve it in the browser: ${ctx.origin}/pending`)
  return lines.join('\n')
}

/**
 * @param {import('./context.mjs').Context} ctx
 * @param {Record<string, any>} task
 * @returns {Promise<Record<string, any>>} the finished task's tool result
 */
export async function waitForTask(ctx, task) {
  const taskId = task.taskId
  let current = task
  if (!isTaskDone(current)) {
    ctx.note(`Task ${taskId} is running on the server. If this command stops, resume with: accounted task ${taskId}`)
  }
  while (!isTaskDone(current)) {
    await ctx.sleep(pollInterval(current))
    current = await ctx.session.rpc('tasks/get', { taskId })
  }
  if (current.status === 'completed' && current.result && typeof current.result === 'object') {
    return current.result
  }
  if (current.status === 'cancelled') throw new UnavailableError(`Task ${taskId} was cancelled`)
  const detail = current.error?.message ?? current.statusMessage ?? 'no details'
  throw new UnavailableError(`Task ${taskId} failed on the server: ${detail}`)
}
