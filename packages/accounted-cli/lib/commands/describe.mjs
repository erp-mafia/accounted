import { UsageError } from '../errors.mjs'
import { canonicalToolName, classifyToolResult } from '../mcp.mjs'

/**
 * accounted describe <tool>: the full definition (input schema included) of
 * one tool, matched by exact name, so the arguments for `accounted call` can
 * be written without guessing.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function describe(ctx, args) {
  if (args.length !== 1) throw new UsageError('Name one tool: accounted describe <tool>')
  const name = canonicalToolName(args[0])
  const bare = name.slice('accounted_'.length)
  const names = new Set([name, `gnubok_${bare}`])

  // Search reaches the specialised tools tools/list leaves out.
  const outcome = classifyToolResult(
    await ctx.session.callTool('accounted_search_tools', { query: bare.replace(/_/g, ' '), detail: 'full', limit: 50 })
  )
  const hits = outcome.kind === 'ok' ? /** @type {any} */ (outcome.data)?.tools : undefined
  let tool = Array.isArray(hits) ? hits.find((t) => names.has(t?.name)) : undefined

  if (!tool) {
    const listed = await ctx.session.rpc('tools/list', {})
    tool = Array.isArray(listed.tools) ? listed.tools.find((t) => names.has(t?.name)) : undefined
  }
  if (!tool) {
    throw new UsageError(
      `No tool named ${name}, or it is outside what this sign-in may use. Search with: accounted tools <words>`
    )
  }
  ctx.out(tool)
}
