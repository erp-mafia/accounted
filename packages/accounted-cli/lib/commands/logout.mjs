import { UsageError } from '../errors.mjs'
import { keyPrefix } from '../output.mjs'

/**
 * accounted logout: forget the local sign-in. The key itself stays valid on
 * the server until the user disconnects it in Settings, so say which one.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function logout(ctx, args) {
  if (args.length > 0) throw new UsageError('logout takes no arguments')
  if (ctx.envKey) {
    ctx.note('ACCOUNTED_API_KEY is set, and nothing is stored to remove. Unset the variable; revoke the key in Settings if it should stop working.')
    ctx.out({ signed_out: false, server: ctx.origin, reason: 'ACCOUNTED_API_KEY is set' })
    return
  }
  const removed = await ctx.store.remove(ctx.origin)
  if (!removed) {
    ctx.note(`Not signed in to ${ctx.origin}.`)
    ctx.out({ signed_out: false, server: ctx.origin, reason: 'not signed in' })
    return
  }
  const prefix = keyPrefix(removed.access_token)
  ctx.note(
    `Removed the sign-in from this computer. Key ${prefix} keeps working until you disconnect it in Settings › API & MCP: ${ctx.origin}/settings/api`
  )
  ctx.out({ signed_out: true, server: ctx.origin, key_prefix: prefix })
}
