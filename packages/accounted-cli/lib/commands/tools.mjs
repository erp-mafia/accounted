import { UnavailableError } from '../errors.mjs'
import { settle } from './settle.mjs'

/**
 * accounted tools [words...]
 *
 * Without words: the common tools (tools/list), one line each. With words:
 * the server's ranked search over every tool, including the specialised
 * ones tools/list leaves out. Both work before login.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function tools(ctx, args) {
  if (args.length > 0) {
    const query = args.join(' ')
    if ((await ctx.session.credential()).source === 'none') {
      ctx.note('Not signed in: the search covers only the tools that work without an account. Run `accounted login` to search everything.')
    }
    return settle(ctx, await ctx.session.callTool('accounted_search_tools', { query, detail: 'summary', limit: 20 }))
  }
  const result = await ctx.session.rpc('tools/list', {})
  if (!Array.isArray(result.tools)) throw new UnavailableError('The server sent no tool list')
  ctx.out(
    result.tools.map((/** @type {Record<string, any>} */ tool) => ({
      name: tool.name,
      description: firstLine(tool.description),
    }))
  )
  ctx.note(`${result.tools.length} common tools. Search all of them with: accounted tools <words>`)
}

/** @param {unknown} text */
function firstLine(text) {
  if (typeof text !== 'string') return ''
  const line = text.split('\n')[0].trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
