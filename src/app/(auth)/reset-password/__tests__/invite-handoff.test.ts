import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  INVITE_COOKIE_NAME,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'
import {
  handoffPendingInvite,
  INVITE_ACCEPTED_DESTINATION,
  INVITE_RETRY_DESTINATION,
  type InviteHandoffDeps,
} from '../invite-handoff'

/**
 * The finding: `/reset-password` was the only session-establishing path that
 * never consumed the pre-auth invite cookie, and the server-side safety nets
 * (`acceptPendingInviteByToken()` on `/onboarding` and `/select-company`) do
 * not cover it, because `/onboarding` is only ever reached by a user with zero
 * companies. A consultant who already had a company of their own could not
 * recover the invitation at all.
 *
 * The flow lives in `../invite-handoff.ts` so it is reachable from the node
 * test env: the page itself is a client component and this repo deliberately
 * has no component harness (CLAUDE.md: scope is lib/ + app/api/). The wiring
 * inside the page is asserted against its source, the same pattern used by
 * app/invite/[token]/__tests__/invite-cookie.test.ts.
 */

const TOKEN = 'gnubok_inv_Zm9vYmFyLXRva2Vu'

/**
 * Minimal document.cookie stand-in (node env has no DOM). Models the one
 * behaviour the shared helper depends on: assigning `name=; max-age=0` removes
 * the entry.
 */
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
let reportProblem: Mock<InviteHandoffDeps['reportProblem']>
let getUser: Mock<InviteHandoffDeps['getUser']>
let getAssuranceLevel: Mock<InviteHandoffDeps['getAssuranceLevel']>

/** An ordinary hosted user: no BankID link, no TOTP step-up owed. */
function deps(overrides: Partial<InviteHandoffDeps> = {}): InviteHandoffDeps {
  return {
    getUser,
    getAssuranceLevel,
    reportProblem,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  reportProblem = vi.fn<InviteHandoffDeps['reportProblem']>()
  getUser = vi
    .fn<InviteHandoffDeps['getUser']>()
    .mockResolvedValue({ app_metadata: {} })
  getAssuranceLevel = vi
    .fn<InviteHandoffDeps['getAssuranceLevel']>()
    .mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal1' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, 'document')
  vi.restoreAllMocks()
})

function respondWith(status: number) {
  fetchMock.mockResolvedValue({ status, ok: status >= 200 && status < 300 })
}

describe('invite handoff after a password reset', () => {
  // The core of the finding: the invitee resets their password and is a member
  // when they land in the app.
  it('joins the invited company and lands the user in the app', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(deps())

    expect(fetchMock).toHaveBeenCalledWith('/api/team/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
    expect(reportProblem).not.toHaveBeenCalled()
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  /**
   * The user shape that motivated the fix. Acceptance is inline and reads no
   * membership state, so a user who already has a company of their own goes
   * through the identical single POST: exactly one request, no company lookup
   * that could branch them away, and never a bounce through `/onboarding`
   * (which they would never be sent to).
   */
  it('joins a user who already has a company of their own too', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(deps())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
    expect(destination).not.toBe('/onboarding')
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('treats already-a-member (409) as joined', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(409)

    const destination = await handoffPendingInvite(deps())

    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
    expect(reportProblem).not.toHaveBeenCalled()
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('retains the token on a transient failure, reports it, and asks for a server-side retry', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(500)

    const destination = await handoffPendingInvite(deps())

    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
    expect(reportProblem).toHaveBeenCalledWith('retryable')
    // /select-company re-runs acceptPendingInviteByToken() server-side and is
    // reachable for a user who already has a company; /onboarding is not.
    expect(destination).toBe(INVITE_RETRY_DESTINATION)
    expect(destination).not.toBe('/onboarding')
  })

  it('retains the token when the request never reaches the server', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const destination = await handoffPendingInvite(deps())

    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
    expect(reportProblem).toHaveBeenCalledWith('retryable')
    expect(destination).toBe(INVITE_RETRY_DESTINATION)
  })

  it('retains the token on an email mismatch (403) without a futile retry', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(403)

    const destination = await handoffPendingInvite(deps())

    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
    expect(reportProblem).toHaveBeenCalledWith('wrong_email')
    // The server-side email equality check would fail identically for this
    // account, so there is nothing for /select-company to retry.
    expect(destination).toBeNull()
  })

  it('clears a spent token (410) and reports it', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(410)

    const destination = await handoffPendingInvite(deps())

    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
    expect(reportProblem).toHaveBeenCalledWith('spent')
    expect(destination).toBeNull()
  })

  it('does nothing at all when there is no invite cookie', async () => {
    installCookieJar({ 'sb-access-token': 'x' })

    const destination = await handoffPendingInvite(deps())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
    expect(reportProblem).not.toHaveBeenCalled()
    expect(destination).toBeNull()
  })
})

/**
 * A recovery session is AAL1, and POST /api/team/accept is NOT in
 * `apiPathSkipsMfaGate`, so the middleware answers a pending step-up with a
 * bare 403. The shared classifier reads 403 as `wrong_email`, so attempting the
 * acceptance there would tell a legitimate invitee their invitation belongs to
 * someone else. Defer instead, on exactly the middleware's own condition.
 */
describe('a session that still owes an MFA step-up', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    getAssuranceLevel.mockResolvedValue({
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    })
  })

  it('defers without touching the token or claiming the wrong address', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(403)

    const destination = await handoffPendingInvite(deps())

    expect(fetchMock).not.toHaveBeenCalled()
    expect(reportProblem).not.toHaveBeenCalled()
    // The same predicate bounces the user to /mfa/verify, which consumes the
    // surviving cookie once the second factor is in.
    expect(jar.get(INVITE_COOKIE_NAME)).toBe(TOKEN)
    expect(destination).toBeNull()
  })

  it('does not defer a BankID-linked user, whom nothing would bounce', async () => {
    const jar = installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(
      deps({ getUser: async () => ({ app_metadata: { bankid_linked: true } }) }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
    expect(jar.has(INVITE_COOKIE_NAME)).toBe(false)
  })

  it('does not defer on self-hosted, where MFA is never enforced', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(deps())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
  })

  it('still attempts when the assurance level cannot be read', async () => {
    installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(
      deps({ getAssuranceLevel: async () => null }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
  })

  // A throw here must never surface as "could not save password": the password
  // was saved before this ran.
  it('still attempts, without throwing, when the session read fails outright', async () => {
    installCookieJar({ [INVITE_COOKIE_NAME]: TOKEN })
    respondWith(200)

    const destination = await handoffPendingInvite(
      deps({
        getUser: async () => {
          throw new TypeError('Failed to fetch')
        },
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(destination).toBe(INVITE_ACCEPTED_DESTINATION)
  })
})

/**
 * The page wiring. Against HEAD every assertion here fails: the page never
 * mentioned the invite at all.
 */
describe('reset-password page wiring', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../page.tsx'), 'utf8')

  it('calls the shared handoff rather than carrying its own copy', () => {
    expect(SRC).toContain("import { handoffPendingInvite } from './invite-handoff'")
    expect(SRC).toContain('await handoffPendingInvite({')
    // The acceptance POST and the cookie writes belong to the shared helper.
    expect(SRC).not.toContain('/api/team/accept')
    expect(SRC).not.toContain('document.cookie')
  })

  it('runs the handoff only after the password has actually been saved', () => {
    const passwordPost = SRC.indexOf("'/api/account/password'")
    const failureGuard = SRC.indexOf('if (!res.ok)')
    const handoff = SRC.indexOf('await handoffPendingInvite({')

    expect(passwordPost).toBeGreaterThan(-1)
    expect(failureGuard).toBeGreaterThan(passwordPost)
    expect(handoff).toBeGreaterThan(failureGuard)
  })

  it('hard-navigates to whatever the handoff returns', () => {
    expect(SRC).toContain('window.location.href = inviteDestination')
  })

  it('never routes invite recovery through /onboarding', () => {
    // /onboarding heals a missed invite server-side but is unreachable for a
    // user who already has a company: that is the whole finding. Comment lines
    // are dropped so prose about it is not mistaken for a navigation.
    const code = SRC.split('\n').filter(
      (line) => !/^\s*(\*|\/\/|\/\*)/.test(line),
    )
    expect(code.join('\n')).not.toContain('/onboarding')
  })

  it('renders the shared invite wording instead of inventing its own', () => {
    expect(SRC).toContain(
      "import { INVITE_PROBLEM_MESSAGE_KEYS } from '@/lib/auth/consume-invite-cookie'",
    )
    expect(SRC).toContain("useTranslations('invite')")
  })
})

/** The toast the page now renders must exist in both locales. */
describe('invite problem wording', () => {
  const messages = (locale: 'sv' | 'en') =>
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, `../../../../messages/${locale}.json`),
        'utf8',
      ),
    ) as { invite: Record<string, string> }

  for (const locale of ['sv', 'en'] as const) {
    it(`has every problem title and body in ${locale}.json`, () => {
      const invite = messages(locale).invite
      for (const { title, body } of Object.values(INVITE_PROBLEM_MESSAGE_KEYS)) {
        expect(invite[title]).toBeTruthy()
        expect(invite[body]).toBeTruthy()
      }
    })
  }
})
