import { UsageError } from '../errors.mjs'
import { settle, waitForTask } from './settle.mjs'

/**
 * accounted task <id>: pick up a long-running tool call where an interrupted
 * `accounted call` left it. Tasks are kept for an hour.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function task(ctx, args) {
  if (args.length !== 1) throw new UsageError('Name the task: accounted task <id>')
  const current = await ctx.session.rpc('tasks/get', { taskId: args[0] })
  return settle(ctx, await waitForTask(ctx, current))
}
