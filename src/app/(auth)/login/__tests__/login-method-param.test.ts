import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Issue #209: "Logga in" from the signup page's "an account with this e-mail
 * already exists" landed on BankID, which then said no account was linked to
 * it. The panel choice lives in lib/auth/login-method.ts (unit-tested there);
 * these assert that the page uses it, on the page source, the same pattern as
 * bankid-landing.test.ts (this repo has no component test harness).
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../login-client.tsx', import.meta.url)),
  'utf8',
)

const CODE = SOURCE.split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join('\n')

function between(startMarker: string, endMarker: string): string {
  const start = CODE.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  const end = CODE.indexOf(endMarker, start)
  expect(end, endMarker).toBeGreaterThan(start)
  return CODE.slice(start, end)
}

describe('the method parameter on /login', () => {
  it('chooses the first panel through the shared resolver, for a plain visit too', () => {
    expect(CODE).toContain(
      'const requestedMethod = loginMethodFromParam(searchParams.get(LOGIN_METHOD_PARAM))',
    )
    const initial = between('const [method, setMethod] = useState<LoginMethod>(', 'const prevMethodRef')
    expect(initial).toContain('resolveInitialLoginMethod({')
    expect(initial).toContain('requested: requestedMethod')
    expect(initial).toContain('remembered: initialMethod')
    expect(initial).toContain('timedOut: timeoutReason !== null')
    expect(initial).toContain('passwordLoginEnabled')
  })

  it('is read in one place and feeds nothing but the panel choice', () => {
    expect(CODE.match(/searchParams\.get\(LOGIN_METHOD_PARAM\)/g)).toHaveLength(1)
    expect(CODE).not.toContain("searchParams.get('method')")
    expect(CODE.match(/requestedMethod/g)).toHaveLength(2)
  })
})

describe('the address the signup page hands over', () => {
  it('is taken from the tab once and only filled in', () => {
    const effect = between('const handedOff = takeLoginEmailHandoff()', '}, [])')
    expect(effect).toContain('setEmail((current) => current || handedOff)')
    // A prefill, never a sign-in: nothing in the effect submits or signs in.
    expect(effect).not.toMatch(/requestSubmit|\.submit\(|signInWithPassword|handlePasswordLogin/)
  })

  it('never comes from the URL', () => {
    expect(CODE).not.toMatch(/searchParams\.get\('email'\)/)
  })
})

describe('BankID finds no account (the reverse case)', () => {
  it('opens the e-mail form under the "Logga in med e-post nedan" message', () => {
    const branch = between("if (result.error === 'no_account') {", 'return')
    expect(branch).toContain('setBankIdNoAccount(')
    expect(branch).toContain("setMethod('email')")
  })
})
