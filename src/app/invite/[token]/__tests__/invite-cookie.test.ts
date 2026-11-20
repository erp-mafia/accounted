import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getInviteExpiry } from '@/lib/auth/invite-tokens'
import { INVITE_TTL_HOURS, INVITE_TTL_SECONDS } from '@/lib/auth/invite-ttl'
import {
  consumeInviteCookie,
  isDefinitiveInviteDisposition,
  INVITE_COOKIE_NAME,
} from '@/lib/auth/consume-invite-cookie'

/**
 * The invite cookie is written by app/invite/[token]/page.tsx before it hands
 * the invitee off to /register or /login. That hop has to survive an email
 * round-trip: the invitee registers at 17:00 and confirms the mail the next
 * morning. The page used to write `max-age=3600` at three separate call sites
 * against a much longer-lived invitation, so the cookie was gone long before
 * the invitee came back and acceptance became impossible with no recovery
 * path.
 *
 * The page is a client component, and this repo deliberately has no component
 * test harness (CLAUDE.md: scope is lib/ + app/api/). These tests therefore
 * assert on the page source, the same pattern already used by
 * components/transactions/__tests__/invoice-match-dialog-fx.test.ts. The
 * expected value is not restated here: it is read back out of
 * `getInviteExpiry()`, the server-side source of the invitation lifetime, so
 * a cookie that stops following INVITE_TTL_HOURS (lib/auth/invite-ttl.ts)
 * fails this file.
 */
const PAGE_PATH = path.resolve(__dirname, '../page.tsx')
const SRC = fs.readFileSync(PAGE_PATH, 'utf8')

/**
 * The real invitation lifetime in seconds, derived from the code that stamps
 * `expires_at` on company and team invitations.
 */
function inviteTtlSeconds(): number {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-06-10T17:00:00.000Z'))
    return (getInviteExpiry().getTime() - Date.now()) / 1000
  } finally {
    vi.useRealTimers()
  }
}

/**
 * Every line of the page that writes the invite cookie. A write is identified
 * by carrying both a max-age and the samesite attribute, which excludes the
 * delete performed elsewhere (`max-age=0`, no other attributes). Comment lines
 * are dropped so prose describing the flags cannot be mistaken for a write.
 */
function cookieWriteLines(): string[] {
  return SRC.split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => line.includes('samesite=lax') && line.includes('max-age='))
}

/**
 * Resolve the max-age used by a cookie write. Handles a bare literal
 * (`max-age=3600`) and an interpolated constant (`max-age=${NAME}`), so the
 * assertion survives either spelling instead of only testing today's one.
 */
function resolveMaxAge(writeLine: string): number {
  const raw = writeLine.match(/max-age=([^;`]+)/)?.[1]?.trim()
  if (!raw) throw new Error(`no max-age in invite cookie write: ${writeLine}`)

  const interpolated = raw.match(/^\$\{(\w+)\}$/)?.[1]
  if (!interpolated) return Number(raw)

  return resolveConstant(interpolated)
}

/**
 * The value of a constant the page uses: the shared invitation lifetime it
 * imports, or a local declaration that is a number, a product of numbers, or
 * another such constant.
 */
function resolveConstant(name: string): number {
  if (name === 'INVITE_TTL_SECONDS') {
    // Only the real constant counts: a local const of the same name would
    // be a restated number again.
    expect(SRC).toMatch(
      /import \{[^}]*\bINVITE_TTL_SECONDS\b[^}]*\} from '@\/lib\/auth\/invite-ttl'/,
    )
    expect(SRC).not.toMatch(/const INVITE_TTL_SECONDS\b/)
    return INVITE_TTL_SECONDS
  }

  const decl = SRC.match(new RegExp(`const ${name} = (.+)`))?.[1]
  if (!decl) throw new Error(`${name} is used but never declared`)

  return decl
    .split('*')
    .map((part) => part.trim())
    .map((part) => (/^\d+$/.test(part) ? Number(part) : resolveConstant(part)))
    .reduce((product, n) => product * n, 1)
}

describe('invite cookie lifetime', () => {
  // The original finding: the page wrote 3600 against a far longer invitation.
  it('lives exactly as long as the invitation it carries', () => {
    const ttl = inviteTtlSeconds()
    // sanity: getInviteExpiry() really stamps the shared lifetime
    expect(ttl).toBe(INVITE_TTL_HOURS * 60 * 60)

    const writes = cookieWriteLines()
    expect(writes.length).toBeGreaterThan(0)

    for (const write of writes) {
      expect(resolveMaxAge(write)).toBe(ttl)
    }
  })

  it('survives the overnight gap between registering and confirming the email', () => {
    const OVERNIGHT_SECONDS = 15 * 60 * 60 // 17:00 to 08:00 the next morning

    for (const write of cookieWriteLines()) {
      expect(resolveMaxAge(write)).toBeGreaterThan(OVERNIGHT_SECONDS)
    }
  })

  // Never longer than the server honours: past expires_at the token is dead
  // regardless, and a cookie outliving that is lifetime nobody grants.
  it('never outlives the server-side bound', () => {
    for (const write of cookieWriteLines()) {
      expect(resolveMaxAge(write)).toBeLessThanOrEqual(inviteTtlSeconds())
    }
  })
})

describe('invite cookie construction', () => {
  // Three separate literals is how the max-age drifts in the first place.
  it('is built in exactly one place', () => {
    expect(cookieWriteLines()).toHaveLength(1)
  })

  // A number restated on the page is how the cookie and the invitation
  // drifted apart before: the lifetime comes from the one constant.
  it('takes its lifetime from the shared invitation lifetime, not a number of its own', () => {
    expect(SRC).toMatch(/const INVITE_COOKIE_MAX_AGE_SECONDS = INVITE_TTL_SECONDS\b/)
  })

  it('is still written on all three hops off the invite page', () => {
    const callSites = SRC.match(/document\.cookie = buildInviteCookie\(/g) ?? []
    expect(callSites).toHaveLength(3)
  })

  it('takes the cookie name from the consume-side helper rather than a literal', () => {
    expect(SRC).toContain("import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'")
    expect(SRC).not.toMatch(/document\.cookie = `gnubok-invite-token=/)
  })
})

describe('invite cookie flags', () => {
  const write = () => cookieWriteLines()[0]

  it('keeps the site-wide path so every auth surface can read it', () => {
    expect(write()).toContain('path=/;')
  })

  it('keeps samesite=lax', () => {
    expect(write()).toContain('samesite=lax')
  })

  it('keeps secure conditional on https and nothing else', () => {
    // The flag is interpolated at the tail of the cookie string, never a
    // hardcoded '; secure' that would break cookie writes on http self-hosts.
    expect(write()).toMatch(/samesite=lax\$\{\w+\}`/)
    expect(SRC).toContain(
      "window.location.protocol === 'https:' ? '; secure' : ''",
    )
  })

  // Not a regression: the cookie is written from document.cookie, so httponly
  // is impossible by construction. Asserted so a future reader does not think
  // the flag was dropped as part of widening the lifetime.
  it('is not httponly, by construction', () => {
    expect(write()).not.toMatch(/httponly/i)
  })
})

/**
 * The consume side (lib/auth/consume-invite-cookie.ts) retains the cookie on
 * transient failures, which compounds with a max-age as long as the
 * invitation. Re-assert here that the cookie is still destroyed the moment
 * the outcome is definitive, so the two do not add up to a token that lingers
 * after it is spent.
 */
describe('the cookie is still cleared on a definitive outcome', () => {
  const TOKEN = 'gnubok_inv_Zm9vYmFyLXRva2Vu'

  function installCookieJar(initial: Record<string, string> = {}) {
    const jar = new Map(Object.entries(initial))

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get cookie() {
          return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
        },
        set cookie(raw: string) {
          const [pair, ...attrs] = raw.split(';').map((s) => s.trim())
          const eq = pair.indexOf('=')
          const name = pair.slice(0, eq)
          const value = pair.slice(eq + 1)
          if (attrs.some((a) => /^max-age=0$/i.test(a)) || value === '') {
            jar.delete(name)
          } else {
            jar.set(name, value)
          }
        },
      },
    })

    return jar
  }

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, 'document')
    vi.restoreAllMocks()
  })

  it('clears the cookie once the invite is accepted', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockResolvedValue({ status: 200, ok: true })

    const result = await consumeInviteCookie()

    expect(isDefinitiveInviteDisposition(result.disposition!)).toBe(true)
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('clears the cookie once the invitation itself has expired (410)', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockResolvedValue({ status: 410, ok: false })

    const result = await consumeInviteCookie()

    expect(result.disposition).toBe('spent')
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('still retains it on a transient failure, now for the full invite window', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockResolvedValue({ status: 500, ok: false })

    const result = await consumeInviteCookie()

    expect(result.cleared).toBe(false)
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
  })
})
