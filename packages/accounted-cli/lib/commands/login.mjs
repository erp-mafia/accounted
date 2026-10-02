import { MCP_PATH } from '../config.mjs'
import { AuthError, UsageError } from '../errors.mjs'
import {
  CALLBACK_PATH,
  PASTE_PORT,
  authorizeUrl,
  createPkce,
  discover,
  exchangeCode,
  parseCallback,
} from '../oauth.mjs'
import { keyPrefix, scopeList } from '../output.mjs'

/**
 * accounted login [--no-browser] [--force]
 *
 * OAuth sign-in through the browser: PKCE, a one-shot callback on 127.0.0.1,
 * and a paste fallback for when the browser cannot reach this machine (SSH,
 * a sandbox, --no-browser).
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {string[]} args
 */
export async function login(ctx, args) {
  if (args.length > 0) throw new UsageError('login takes no arguments')
  if (ctx.envKey) {
    throw new UsageError('ACCOUNTED_API_KEY is set, so no login is needed. Unset it to sign in through the browser.')
  }
  const previous = await ctx.store.read(ctx.origin)
  if (previous && !ctx.flags.force) {
    throw new UsageError(
      `Already signed in to ${ctx.origin} (key ${keyPrefix(previous.access_token)}). Run \`accounted logout\` first, or pass --force.`
    )
  }
  // Before the server mints a key: if it cannot be saved, stop here.
  await ctx.store.ensureWritable()

  const server = await discover(ctx.send, ctx.origin, ctx.headers)
  const pkce = createPkce(ctx.randomBytes)
  const state = ctx.randomBytes(16).toString('base64url')

  let loopback = null
  if (!ctx.flags['no-browser']) {
    try {
      loopback = await ctx.startLoopback()
    } catch (err) {
      ctx.note(`Cannot listen on 127.0.0.1 (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'}); paste the address instead.`)
    }
  }
  const canPaste = ctx.stdin.isTTY === true
  if (!loopback && !canPaste) {
    throw new UsageError('Cannot finish a sign-in here: nothing can receive the browser and there is no terminal to paste into. Run `accounted login` in your own terminal.')
  }

  const redirectUri = loopback ? loopback.redirectUri : `http://127.0.0.1:${PASTE_PORT}${CALLBACK_PATH}`
  const url = authorizeUrl({
    authorizationEndpoint: server.authorizationEndpoint,
    redirectUri,
    state,
    challenge: pkce.challenge,
    resource: new URL(MCP_PATH, ctx.origin).toString(),
  })

  ctx.note('Sign in to Accounted in your browser:')
  ctx.note(`  ${url}`)
  if (loopback) {
    ctx.openBrowser(url)
    ctx.note(
      canPaste
        ? 'Waiting for the browser. If it cannot reach this machine, paste the address it ends on here and press Enter.'
        : 'Waiting for the browser.'
    )
  } else {
    ctx.note("After you approve, the browser ends on a page that cannot load. Copy that page's whole address, paste it here and press Enter.")
  }

  const callback = await firstAnswer(ctx, loopback, canPaste)
  const code = parseCallback(callback, { state, issuer: server.issuer })
  const tokens = await exchangeCode(ctx.send, {
    tokenEndpoint: server.tokenEndpoint,
    code,
    verifier: pkce.verifier,
    redirectUri,
    headers: ctx.headers,
  })
  const now = new Date().toISOString()
  await ctx.store.write(ctx.origin, {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_endpoint: server.tokenEndpoint,
    issuer: server.issuer,
    scope: tokens.scope,
    created_at: now,
    updated_at: now,
  })

  if (previous) {
    ctx.note(
      `The previous sign-in (key ${keyPrefix(previous.access_token)}) keeps working until you disconnect it in Settings: ${ctx.origin}/settings/api`
    )
  }
  ctx.note(`Signed in to ${ctx.origin}.`)
  ctx.out({
    signed_in: true,
    server: ctx.origin,
    key_prefix: keyPrefix(tokens.accessToken),
    scopes: scopeList(tokens.scope),
  })
}

/**
 * Whichever arrives first: the browser hitting the loopback, or a pasted
 * address. Both are cleaned up afterwards so the process can exit.
 *
 * @param {import('./context.mjs').Context} ctx
 * @param {{ result: Promise<string>, close: () => void } | null} loopback
 * @param {boolean} canPaste
 */
async function firstAnswer(ctx, loopback, canPaste) {
  const paste = canPaste ? ctx.readPastedLine(ctx.stdin) : null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AuthError('Sign-in timed out after 5 minutes. Run `accounted login` again.')),
      ctx.loginTimeoutMs
    )
  })
  try {
    /** @type {Promise<string>[]} */
    const answers = []
    if (loopback) answers.push(loopback.result)
    if (paste) answers.push(paste.line)
    return await Promise.race([...answers, timeout])
  } finally {
    clearTimeout(timer)
    loopback?.close()
    paste?.cancel()
  }
}
