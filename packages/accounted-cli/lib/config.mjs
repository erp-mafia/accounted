import path from 'node:path'
import { UsageError } from './errors.mjs'

export const DEFAULT_ORIGIN = 'https://app.accounted.se'
export const MCP_PATH = '/api/extensions/ext/mcp-server/mcp'

// Same pattern as packages/accounted-mcp: company ids are v1-v5 UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Resolve the server from --url / ACCOUNTED_URL. Accepts the app address
 * (https://app.accounted.se) or the full MCP URL the accounted-mcp bridge
 * documents. Anything else is refused rather than guessed at.
 *
 * A `company` query parameter is refused too: dropping it silently would
 * widen the connection to every company the sign-in reaches, so the pin
 * must come from --company or ACCOUNTED_COMPANY where it is validated.
 *
 * @param {string | undefined} raw
 * @returns {{ origin: string, insecure: boolean }}
 */
export function resolveServer(raw) {
  const value = (raw ?? '').trim() || DEFAULT_ORIGIN
  let url
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`The server URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`The server URL must start with https:// (got ${url.protocol}//)`)
  }
  if (url.username || url.password) {
    throw new UsageError('The server URL must not contain a user name or password')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname !== '' && pathname !== MCP_PATH) {
    throw new UsageError(
      `The server URL must be the app address (for example ${DEFAULT_ORIGIN}) or its MCP URL, not ${value}`
    )
  }
  if (url.searchParams.has('company')) {
    throw new UsageError(
      'Pass the company with --company or ACCOUNTED_COMPANY, not in the server URL'
    )
  }
  return { origin: url.origin, insecure: url.protocol === 'http:' && !isLoopbackHost(url.hostname) }
}

/** @param {string} hostname */
export function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Validate the optional company pin. A value that is not a UUID is a hard
 * error: a pin exists to narrow the connection, so a typo must never fall
 * open to every company the sign-in reaches.
 *
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function resolveCompany(raw) {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '') return undefined
  if (!UUID_RE.test(value)) {
    throw new UsageError(
      'The company must be a company id (a UUID from `accounted call list_companies`)'
    )
  }
  return value
}

/**
 * The MCP endpoint for one request. tool_namespace=accounted gives the
 * accounted_* tool names; the server accepts gnubok_* on input either way.
 *
 * @param {string} origin
 * @param {string | undefined} company
 */
export function mcpUrl(origin, company) {
  const url = new URL(MCP_PATH, origin)
  url.searchParams.set('tool_namespace', 'accounted')
  if (company) url.searchParams.set('company', company)
  return url.toString()
}

/**
 * Where credentials live: %APPDATA%\accounted on Windows, otherwise
 * $XDG_CONFIG_HOME/accounted or ~/.config/accounted (macOS included, as gh
 * does).
 *
 * @param {{ env: Record<string, string | undefined>, platform: string, homedir: string }} ctx
 */
export function configDir({ env, platform, homedir }) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(homedir, 'AppData', 'Roaming')
    return path.win32.join(appData, 'accounted')
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && path.posix.isAbsolute(xdg)) return path.posix.join(xdg, 'accounted')
  return path.posix.join(homedir, '.config', 'accounted')
}
