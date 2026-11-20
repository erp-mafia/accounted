import { UnavailableError, UsageError } from '../errors.mjs'

/**
 * accounted guide: the instructions an MCP client receives automatically on
 * connect (workflows, approval rules, company handling), printed as text.
 * Works before login; signed in, it also names the default company.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function guide(ctx, args) {
  if (args.length > 0) throw new UsageError('guide takes no arguments')
  const result = await ctx.session.rpc('server/discover', {})
  if (typeof result.instructions !== 'string') {
    throw new UnavailableError('The server sent no instructions')
  }
  ctx.text(result.instructions)
}
