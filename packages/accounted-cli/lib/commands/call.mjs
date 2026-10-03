import { UsageError } from '../errors.mjs'
import { readArguments } from '../input.mjs'
import { canonicalToolName } from '../mcp.mjs'
import { settle } from './settle.mjs'

/**
 * accounted call <tool> [<json> | @file.json | -]
 *
 * Any tool, listed or search-only, by name. Writes stage for approval exactly
 * as they do over MCP.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function call(ctx, args) {
  if (args.length === 0) throw new UsageError('Name the tool: accounted call <tool> [json]')
  if (args.length > 2) {
    throw new UsageError('Pass the arguments as one JSON object, for example: accounted call list_invoices \'{"limit": 5}\'')
  }
  const name = canonicalToolName(args[0])
  const input = await readArguments(args[1], ctx)
  return settle(ctx, await ctx.session.callTool(name, input))
}
