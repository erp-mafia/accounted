/**
 * npm run local:check -- <path> [<path> ...]: open each path of the app that
 * `npm run local:up` started, logged in as its seeded user through the real
 * login form, in headless Firefox at 400 px wide, once in Swedish and once in
 * English, and report what a customer would hit there:
 *
 *   console_error        console.error in the browser (React and hydration errors included)
 *   page_error           an uncaught exception or rejection in the page
 *   http_5xx             any response >= 500, the page itself or a fetch it makes
 *   missing_translation  a next-intl MISSING_MESSAGE, in the browser or the dev server log
 *   server_error         a ⨯ line in the dev server log while the page loaded
 *   login_redirect       the page sent the logged-in user back to /login
 *   horizontal_scroll    the page is wider than the 400 px viewport
 *
 * Prints a JSON summary and saves a full-page screenshot per page and locale
 * under .local/screenshots/<run>/. Exit code 0 with no findings, 1 with any,
 * 2 when the check itself could not run.
 *
 * Usage:
 *   npm run local:check -- / /onboarding /bookkeeping
 *   LOCAL_CHECK_FIREFOX=/path/to/firefox npm run local:check -- /
 */
import fs from 'node:fs'
import path from 'node:path'
import type { HTTPRequest, Page, PuppeteerNode } from 'puppeteer-core'
import {
  SCREENSHOT_DIR,
  classifyConsoleError,
  classifyServerLogLine,
  dedupeFindings,
  screenshotName,
  summarize,
  type Finding,
  type PageResult,
} from './lib'
import { readState, stackPaths } from './stack'

const LOCALES = ['sv', 'en'] as const
const VIEWPORT = { width: 400, height: 900 }
/** A cold `next dev` compiles a route on its first request; the slowest take over a minute. */
const NAVIGATION_TIMEOUT_MS = 180_000
const FIREFOX_CANDIDATES = ['/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox']

const repoRoot = process.cwd()
const paths = stackPaths(repoRoot)

/** The check itself could not run (exit 2), as opposed to a page with findings (exit 1). */
class CheckAborted extends Error {}

function abort(message: string): never {
  throw new CheckAborted(`local:check: ${message}`)
}

/** Loaded at run time, so a checkout without it gets the fix instead of a module-not-found trace. */
async function loadPuppeteer(): Promise<PuppeteerNode> {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) {
    abort(`puppeteer-core needs Node 22.12 or newer and this is ${process.version}: put a newer node first on PATH`)
  }
  try {
    return (await import('puppeteer-core')).default
  } catch {
    return abort(
      "puppeteer-core is not installed (a worktree's node_modules is a copy of the main checkout's, which can lag " +
        'package-lock.json): run npm ci here (npm 12: npm ci --allow-remote=root)',
    )
  }
}

const truncate = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}...` : text)

/**
 * Firefox's BiDi console events carry an Error argument as an opaque handle,
 * so the page's console.error is wrapped to pass Errors and objects on as
 * text. Runs before any page script. A string, not a function: tsx compiles
 * named inner functions with a __name() helper the page does not have.
 */
const READABLE_CONSOLE_ERRORS = `(() => {
  const original = console.error.bind(console)
  const describe = (value) => {
    if (value instanceof Error) return value.name + ': ' + value.message + (value.stack ? '\\n' + value.stack : '')
    if (typeof value === 'object' && value !== null) {
      try { return JSON.stringify(value) } catch { return String(value) }
    }
    return value
  }
  console.error = (...args) => original(...args.map(describe))
})()`

/** Requests that stay open by design and never mean the page is still loading. */
const isLongLived = (url: string) => url.startsWith('ws') || url.includes('/_next/webpack-hmr') || url.includes('/realtime/')

/** Wait until no request has been in flight for a second, at most 30 s. */
async function settle(inflight: Set<HTTPRequest>, lastActivity: { at: number }): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (inflight.size === 0 && Date.now() - lastActivity.at > 1_000) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

function logSize(): number {
  try {
    return fs.statSync(paths.devLog).size
  } catch {
    return 0
  }
}

function serverFindings(fromOffset: number): Finding[] {
  const size = logSize()
  if (size <= fromOffset) return []
  const fd = fs.openSync(paths.devLog, 'r')
  const buffer = Buffer.alloc(size - fromOffset)
  fs.readSync(fd, buffer, 0, buffer.length, fromOffset)
  fs.closeSync(fd)
  const findings: Finding[] = []
  for (const line of buffer.toString('utf8').split('\n')) {
    const kind = classifyServerLogLine(line)
    if (kind) findings.push({ kind, detail: truncate(line.trim()) })
  }
  return findings
}

async function main(): Promise<void> {
  const state = readState(repoRoot)
  if (!state) abort('no local stack here: run npm run local:up first')
  const pagePaths = process.argv.slice(2).filter((arg) => arg.startsWith('/'))
  if (pagePaths.length === 0) pagePaths.push('/')
  const firefox = process.env.LOCAL_CHECK_FIREFOX ?? FIREFOX_CANDIDATES.find((p) => fs.existsSync(p))
  if (!firefox) abort('Firefox not found; set LOCAL_CHECK_FIREFOX to its executable')

  const runDir = path.join(paths.dir, SCREENSHOT_DIR, new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(runDir, { recursive: true })

  const puppeteer = await loadPuppeteer()
  const browser = await puppeteer.launch({ browser: 'firefox', executablePath: firefox, headless: true })
  const results: PageResult[] = []
  try {
    const page: Page = await browser.newPage()
    await page.setViewport(VIEWPORT)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    await page.evaluateOnNewDocument(READABLE_CONSOLE_ERRORS)

    // Every event lands on the page being checked at the time.
    let findings: Finding[] = []
    const inflight = new Set<HTTPRequest>()
    const lastActivity = { at: Date.now() }
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      findings.push({ kind: classifyConsoleError(text), detail: truncate(text) })
    })
    page.on('pageerror', (error) => {
      // Firefox's message already starts with the error's name.
      findings.push({ kind: 'page_error', detail: truncate(error instanceof Error ? error.message : String(error)) })
    })
    page.on('response', (response) => {
      if (response.status() >= 500) {
        findings.push({ kind: 'http_5xx', detail: `${response.status()} ${response.request().method()} ${response.url()}` })
      }
    })
    page.on('request', (request) => {
      if (isLongLived(request.url())) return
      inflight.add(request)
      lastActivity.at = Date.now()
    })
    const done = (request: HTTPRequest) => {
      inflight.delete(request)
      lastActivity.at = Date.now()
    }
    page.on('requestfinished', done)
    page.on('requestfailed', done)

    const visit = async (pagePath: string, locale: string, action?: () => Promise<void>) => {
      findings = []
      const offset = logSize()
      const response = await page.goto(`${state.appUrl}${pagePath}`, { waitUntil: 'load' })
      await settle(inflight, lastActivity)
      if (action) await action()
      const finalPath = new URL(page.url()).pathname
      if (pagePath !== '/login' && finalPath.startsWith('/login')) {
        findings.push({ kind: 'login_redirect', detail: `${pagePath} ended on ${finalPath}` })
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) {
        findings.push({ kind: 'horizontal_scroll', detail: `${overflow}px wider than the ${VIEWPORT.width}px viewport` })
      }
      const screenshot = path.join(runDir, screenshotName(locale, pagePath))
      await page.screenshot({ path: screenshot as `${string}.png`, fullPage: true })
      findings.push(...serverFindings(offset))
      results.push({
        path: pagePath,
        locale,
        status: response?.status() ?? null,
        finalPath,
        screenshot: path.relative(repoRoot, screenshot),
        findings: dedupeFindings(findings),
      })
    }

    // The real login form, after React has hydrated it: typed into before
    // that, the form submits natively and the password lands in the URL.
    await visit('/login', 'sv', async () => {
      await page.waitForFunction(
        () => {
          const input = document.querySelector('#password')
          return !!input && Object.keys(input).some((key) => key.startsWith('__reactProps'))
        },
        { timeout: 60_000 },
      )
      await page.type('#email', state.email)
      await page.type('#password', state.password)
      await Promise.all([
        page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: NAVIGATION_TIMEOUT_MS }),
        page.click('form:has(#password) button[type="submit"]'),
      ])
      await settle(inflight, lastActivity)
    })
    if (new URL(page.url()).pathname.startsWith('/login')) abort('login did not leave /login')

    for (const locale of LOCALES) {
      const status = await page.evaluate(async (value) => {
        const res = await fetch('/api/user/locale', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locale: value }),
        })
        return res.status
      }, locale)
      if (status !== 200) abort(`switching the language to ${locale} answered ${status}`)
      for (const pagePath of pagePaths) await visit(pagePath, locale)
    }
    // Leave the seeded user on the default language.
    await page.evaluate(() =>
      fetch('/api/user/locale', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"locale":"sv"}' }),
    )
  } finally {
    await browser.close()
  }

  const summary = summarize(results)
  console.log(JSON.stringify({ ...summary, screenshots: path.relative(repoRoot, runDir) }, null, 2))
  process.exit(summary.ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err instanceof CheckAborted ? err.message : err)
  process.exit(2)
})
