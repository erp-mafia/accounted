import { AuthError, UnavailableError } from './errors.mjs'
import { MCP_TIMEOUT_MS } from './http.mjs'
import { envelope, unwrapRpc } from './mcp.mjs'
import { refreshTokens } from './oauth.mjs'
import { mcpUrl } from './config.mjs'

/**
 * Sends MCP requests with whichever credential applies: ACCOUNTED_API_KEY
 * first, otherwise the saved sign-in, otherwise none (discovery, tools/list
 * and search work anonymously).
 *
 * The saved access key does not expire on its own; it stops working only
 * when the user disconnects it or another process renews it. So renewal
 * happens after a 401 and never on a timer: a timed renewal inside a sandbox
 * that cannot save the rotated tokens would spend them and end the sign-in.
 *
 * @param {{
 *   origin: string,
 *   company: string | undefined,
 *   envKey: string | undefined,
 *   store: ReturnType<typeof import('./store.mjs').createStore>,
 *   send: typeof import('./http.mjs').send,
 *   headers: Record<string, string>,
 * }} options
 */
export function createSession({ origin, company, envKey, store, send, headers }) {
  const url = mcpUrl(origin, company)

  /** @param {object} body @param {string | undefined} token */
  function post(body, token) {
    return send({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: MCP_TIMEOUT_MS,
    })
  }

  /**
   * Renew under the lock. Returns the credentials to use, or null when the
   * sign-in has ended.
   *
   * @param {string} rejected the access token the server just refused
   */
  async function renew(rejected) {
    let release
    try {
      release = await store.lock()
    } catch (err) {
      if (err instanceof UnavailableError) throw err
      throw new AuthError(
        `The sign-in needs renewing, but ${store.dir} cannot be written here (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'}). Run \`accounted status\` once in your own terminal to renew it.`
      )
    }
    try {
      const current = await store.read(origin)
      if (!current) return null
      // Another process renewed while we waited for the lock.
      if (current.access_token !== rejected) return current
      const outcome = await refreshTokens(send, {
        tokenEndpoint: current.token_endpoint,
        refreshToken: current.refresh_token,
        headers,
      })
      if (outcome.invalidGrant) {
        await store.remove(origin)
        return null
      }
      const renewed = {
        ...current,
        access_token: outcome.tokens.accessToken,
        refresh_token: outcome.tokens.refreshToken,
        scope: outcome.tokens.scope || current.scope,
        updated_at: new Date().toISOString(),
      }
      await store.write(origin, renewed)
      return renewed
    } finally {
      release()
    }
  }

  return {
    /** Which credential a request would use, without any network call. */
    async credential() {
      if (envKey) return { source: 'env', token: envKey, stored: null }
      const stored = await store.read(origin)
      if (stored) return { source: 'login', token: stored.access_token, stored }
      return { source: 'none', token: undefined, stored: null }
    },

    /**
     * One JSON-RPC call; returns its result or throws by exit code.
     *
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     * @param {{ tasks?: boolean }} [options]
     */
    async rpc(method, params = {}, options = {}) {
      const body = envelope(method, params, options)
      const credential = await this.credential()
      let res = await post(body, credential.token)
      if (res.status !== 401) return unwrapRpc(res)

      if (credential.source === 'none') {
        throw new AuthError('Not signed in. Run `accounted login`, or set ACCOUNTED_API_KEY.')
      }
      if (credential.source === 'env') {
        throw new AuthError(
          `ACCOUNTED_API_KEY was refused by ${origin}: it is revoked, mistyped, or belongs to another server.`
        )
      }

      let rejected = /** @type {string} */ (credential.token)
      const latest = await store.read(origin)
      if (latest && latest.access_token !== rejected) {
        res = await post(body, latest.access_token)
        if (res.status !== 401) return unwrapRpc(res)
        rejected = latest.access_token
      }
      const renewed = await renew(rejected)
      if (!renewed) {
        throw new AuthError(
          'The sign-in has ended (disconnected in Settings, or no longer valid). Run `accounted login`.'
        )
      }
      res = await post(body, renewed.access_token)
      if (res.status === 401) {
        throw new AuthError('The server refused the renewed sign-in. Run `accounted login`.')
      }
      return unwrapRpc(res)
    },

    /**
     * tools/call with the Tasks extension declared.
     *
     * @param {string} name canonical accounted_* name
     * @param {Record<string, unknown>} args
     */
    callTool(name, args) {
      return this.rpc('tools/call', { name, arguments: args }, { tasks: true })
    },
  }
}
