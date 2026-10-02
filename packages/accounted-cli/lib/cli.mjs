import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { openBrowser } from './browser.mjs'
import { configDir, resolveCompany, resolveServer } from './config.mjs'
import { AuthError, EXIT, UnavailableError, UsageError } from './errors.mjs'
import { send as httpSend } from './http.mjs'
import { LOGIN_TIMEOUT_MS, readPastedLine, startLoopback } from './oauth.mjs'
import { writeJson, writeNote } from './output.mjs'
import { createSession } from './session.mjs'
import { createStore } from './store.mjs'
import { CLIENT_NAME, VERSION } from './version.mjs'
import { call } from './commands/call.mjs'
import { describe } from './commands/describe.mjs'
import { guide } from './commands/guide.mjs'
import { login } from './commands/login.mjs'
import { logout } from './commands/logout.mjs'
import { status } from './commands/status.mjs'
import { task } from './commands/task.mjs'
import { tools } from './commands/tools.mjs'

const COMMANDS = { login, logout, status, guide, tools, describe, call, task }

export const USAGE = `accounted ${VERSION}: Accounted bookkeeping from the command line

Usage:
  accounted login [--no-browser] [--force]   Sign in through the browser
  accounted logout                           Forget the sign-in on this computer
  accounted status                           Server, sign-in and companies (exit 3 if not signed in)
  accounted guide                            How to work with Accounted: workflows, approvals, companies
  accounted tools [words...]                 List the common tools, or search all of them
  accounted describe <tool>                  A tool's definition and input schema
  accounted call <tool> [json|@file.json|-]  Run a tool; arguments are one JSON object
  accounted task <id>                        Resume waiting for a long-running call

Options:
  --url <address>      Server (default https://app.accounted.se), or ACCOUNTED_URL
  --company <id>       Pin every call to one company, or ACCOUNTED_COMPANY
  -h, --help           Show this help
  -v, --version        Show the version

ACCOUNTED_API_KEY=<key> uses an API key from Settings instead of a login.
Writes are staged: nothing is booked until the user approves.
Exit codes: 0 ok, 1 tool error, 2 usage, 3 not signed in, 4 server or network.
`

const OPTIONS = /** @type {const} */ ({
  url: { type: 'string' },
  company: { type: 'string' },
  'no-browser': { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
})

/**
 * Run one command. Everything with side effects comes in through `deps`, so
 * tests drive the whole CLI without touching the network or the real home
 * directory.
 *
 * @param {string[]} argv
 * @param {Partial<Deps>} [overrides]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const note = (/** @type {string} */ text) => writeNote(deps.stderr, text)

  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (err) {
    note(`accounted: ${/** @type {Error} */ (err).message}`)
    note('Run `accounted --help` for usage.')
    return EXIT.USAGE
  }
  const { values: flags, positionals } = parsed
  if (flags.version) {
    deps.stdout.write(`${VERSION}\n`)
    return EXIT.OK
  }
  const [command, ...args] = positionals
  if (flags.help || command === 'help') {
    deps.stdout.write(USAGE)
    return EXIT.OK
  }
  if (!command) {
    deps.stderr.write(USAGE)
    return EXIT.USAGE
  }
  const handler = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)]
  if (!handler) {
    note(`accounted: unknown command "${command}". Run \`accounted --help\` for usage.`)
    return EXIT.USAGE
  }

  try {
    if (command !== 'login' && (flags['no-browser'] || flags.force)) {
      throw new UsageError('--no-browser and --force belong to `accounted login`')
    }
    const server = resolveServer(flags.url ?? deps.env.ACCOUNTED_URL)
    const company = resolveCompany(flags.company ?? deps.env.ACCOUNTED_COMPANY)
    const envKey = deps.env.ACCOUNTED_API_KEY?.trim() || undefined
    if (server.insecure) {
      note(`accounted: warning: ${server.origin} is plain http; the sign-in travels unencrypted.`)
    }

    const headers = {
      'User-Agent': `${CLIENT_NAME} node/${process.version}`,
      'X-Accounted-Client': CLIENT_NAME,
    }
    const store = createStore({ dir: configDir(deps) })
    const session = createSession({
      origin: server.origin,
      company,
      envKey,
      store,
      send: deps.send,
      headers,
    })

    /** @type {import('./commands/context.mjs').Context} */
    const ctx = {
      origin: server.origin,
      company,
      envKey,
      flags,
      env: deps.env,
      stdin: deps.stdin,
      platform: deps.platform,
      headers,
      store,
      session,
      send: deps.send,
      openBrowser: (url) => deps.openBrowser(url, { platform: deps.platform }),
      startLoopback: deps.startLoopback,
      readPastedLine: deps.readPastedLine,
      readFile: deps.readFile,
      randomBytes: deps.randomBytes,
      sleep: deps.sleep,
      loginTimeoutMs: deps.loginTimeoutMs,
      out: (value) => writeJson(deps.stdout, value),
      text: (value) => deps.stdout.write(`${value}\n`),
      err: (value) => writeJson(deps.stderr, value),
      note,
    }
    return (await handler(ctx, args)) ?? EXIT.OK
  } catch (err) {
    return report(err, note)
  }
}

/**
 * @param {unknown} err
 * @param {(text: string) => void} note
 */
function report(err, note) {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof UsageError) {
    note(`accounted: ${message}`)
    return EXIT.USAGE
  }
  if (err instanceof AuthError) {
    note(`accounted: ${message}`)
    return EXIT.AUTH
  }
  if (err instanceof UnavailableError) {
    note(`accounted: ${message}`)
    return EXIT.UNAVAILABLE
  }
  note(`accounted: unexpected error: ${err instanceof Error && err.stack ? err.stack : message}`)
  return EXIT.UNAVAILABLE
}

/**
 * @typedef {ReturnType<typeof defaultDeps>} Deps
 */
function defaultDeps() {
  return {
    env: /** @type {Record<string, string | undefined>} */ (process.env),
    stdout: /** @type {{ write: (chunk: string) => unknown, isTTY?: boolean }} */ (process.stdout),
    stderr: /** @type {{ write: (chunk: string) => unknown, isTTY?: boolean }} */ (process.stderr),
    stdin: /** @type {NodeJS.ReadableStream & { isTTY?: boolean }} */ (process.stdin),
    platform: /** @type {string} */ (process.platform),
    homedir: os.homedir(),
    send: httpSend,
    openBrowser,
    startLoopback,
    readPastedLine,
    readFile: (/** @type {string} */ file) => fs.promises.readFile(file),
    randomBytes: /** @type {(size: number) => Buffer} */ ((size) => crypto.randomBytes(size)),
    sleep: (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
  }
}
