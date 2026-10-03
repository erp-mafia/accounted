import { AuthError, EXIT, UsageError } from '../errors.mjs'
import { classifyToolResult } from '../mcp.mjs'
import { keyPrefix, scopeList } from '../output.mjs'

/**
 * accounted status: which server, which credential, and whether it works
 * (one read: the companies it reaches). Exit 3 when not signed in, so a
 * script or agent can test for it. Also renews a sign-in that needs it,
 * which is why a sandboxed agent is told to have the user run this.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function status(ctx, args) {
  if (args.length > 0) throw new UsageError('status takes no arguments')
  const credential = await ctx.session.credential()
  const report = {
    server: ctx.origin,
    company_pin: ctx.company ?? null,
    signed_in: false,
    credential: credential.source === 'env' ? 'ACCOUNTED_API_KEY' : credential.source === 'login' ? 'login' : null,
    key_prefix: credential.token ? keyPrefix(credential.token) : null,
    scopes: credential.stored ? scopeList(credential.stored.scope) : null,
  }
  if (credential.source === 'none') {
    ctx.out(report)
    ctx.note('Not signed in. Run `accounted login`, or set ACCOUNTED_API_KEY.')
    return EXIT.AUTH
  }

  let result
  try {
    result = await ctx.session.callTool('accounted_list_companies', {})
  } catch (err) {
    if (!(err instanceof AuthError)) throw err
    ctx.out(report)
    ctx.note(err.message)
    return EXIT.AUTH
  }
  const after = await ctx.session.credential()
  const outcome = classifyToolResult(result)
  ctx.out({
    ...report,
    signed_in: true,
    key_prefix: after.token ? keyPrefix(after.token) : report.key_prefix,
    ...(outcome.kind === 'ok' ? { companies: companiesFrom(outcome.data) } : {}),
    ...(outcome.kind === 'error' ? { companies_error: outcome.error } : {}),
  })
}

/** @param {unknown} data */
function companiesFrom(data) {
  if (data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).companies)) {
    return /** @type {any} */ (data).companies
  }
  return data
}
