import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Two findings on the signup page, both about an address travelling (or not)
 * with the user.
 *
 * 1. The BankID signup form left its email field blank and editable while the
 *    password form on the very same page pre-filled and locked it from the
 *    invitation. An invitee who chose BankID therefore typed their private
 *    address, POST /api/team/accept answered 403 on its email equality check,
 *    and they landed on /select-company with no membership. The token now
 *    survives that 403 (lib/auth/consume-invite-cookie.ts retains it on
 *    `wrong_email`, and /select-company re-runs acceptance server-side), so the
 *    dead end is recoverable; the signup still should not walk into it.
 * 2. The duplicate-email screen linked to `/login?email=...`, which
 *    app/(auth)/login/page.tsx never reads. The address rode along in the URL,
 *    the browser history, the Referer header and every proxy access log, and
 *    arrived nowhere. Since issue #209 the address does arrive, filled in on
 *    the login form, but through the tab's sessionStorage
 *    (lib/auth/login-email-handoff.ts), still never the URL.
 *
 * The page is a client component and this repo deliberately has no component
 * test harness (CLAUDE.md: scope is lib/ + app/api/), so these assert on the
 * page source, the same pattern used by
 * app/(auth)/reset-password/__tests__/invite-handoff.test.ts and
 * app/invite/[token]/__tests__/invite-cookie.test.ts.
 */
const SRC = fs.readFileSync(
  path.resolve(__dirname, '../register-client.tsx'),
  'utf8',
)

/** The page source with comment lines dropped, so prose about a pattern is never mistaken for the pattern. */
const CODE = SRC.split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join('\n')

/** The props of one `<Input>`, located by its id. */
function inputProps(id: string): string {
  const anchor = SRC.indexOf(`id="${id}"`)
  expect(anchor, `no <Input id="${id}"> on the page`).toBeGreaterThan(-1)
  return SRC.slice(SRC.lastIndexOf('<Input', anchor), SRC.indexOf('/>', anchor) + 2)
}

/** A whole labelled field group (Label + Input + hint), located by the input's id. */
function fieldGroup(id: string): string {
  const anchor = SRC.indexOf(`id="${id}"`)
  expect(anchor, `no <Input id="${id}"> on the page`).toBeGreaterThan(-1)
  return SRC.slice(
    SRC.lastIndexOf('<div className="space-y-2">', anchor),
    SRC.indexOf('</div>', anchor) + '</div>'.length,
  )
}

/** The body of the effect that resolves `?invite=` into the invited address. */
function inviteEffect(): string {
  const start = SRC.indexOf("searchParams.get('invite')")
  expect(start).toBeGreaterThan(-1)
  return SRC.slice(start, SRC.indexOf('}, [searchParams])', start))
}

/**
 * Just the duplicate-email screen. Scoped, because the page footer carries its
 * own bare `/login` link and would satisfy an unscoped assertion.
 */
function duplicateScreen(): string {
  const start = CODE.indexOf('if (duplicateEmail) {')
  expect(start).toBeGreaterThan(-1)
  const end = CODE.indexOf('if (isRegistered) {', start)
  expect(end).toBeGreaterThan(start)
  return CODE.slice(start, end)
}

describe('an invited signup', () => {
  it('pre-fills the BankID email field from the invitation, not just the password one', () => {
    const effect = inviteEffect()
    expect(effect).toContain('setEmail(data.data.email)')
    expect(effect).toContain('setBankIdEmail(data.data.email)')
  })

  it('locks the BankID email field exactly the way the password field is locked', () => {
    // Same invitation, same page: one behaviour. The divergence was the bug.
    for (const id of ['email', 'bankid_email']) {
      const props = inputProps(id)
      expect(props, id).toContain('disabled={isLoading || !!inviteEmail}')
      expect(props, id).toContain('readOnly={!!inviteEmail}')
    }
  })

  it('tells the invitee where the locked address came from', () => {
    expect(fieldGroup('bankid_email')).toContain("t('invite_email_hint')")
    expect(fieldGroup('email')).toContain("t('invite_email_hint')")
  })

  it('still submits the invited address although a disabled input is not in the FormData', () => {
    // `disabled` (unlike `readOnly`) excludes a field from FormData, so the
    // locked value only reaches the request through the state fallback. Both
    // handlers rely on it; dropping either fallback would POST an empty email.
    expect(CODE).toContain("(formData.get('bankid_email') as string) || bankIdEmail")
    expect(CODE).toContain("(formData.get('email') as string) || email")
  })
})

describe('a signup that did not come from an invitation', () => {
  // The overwhelming majority. Nothing may lock or pre-fill for these users.
  it('starts with no invited address', () => {
    expect(CODE).toContain('const [inviteEmail, setInviteEmail] = useState<string | null>(null)')
    expect(CODE).toContain("const [bankIdEmail, setBankIdEmail] = useState('')")
  })

  it('never resolves an invitation when the link carries no token', () => {
    expect(inviteEffect()).toContain('if (!inviteToken) return')
  })

  it('leaves both email fields editable, gating every lock on the invitation', () => {
    for (const id of ['email', 'bankid_email']) {
      const props = inputProps(id)
      // No unconditional lock: every disabled/readOnly here names inviteEmail.
      const locks = props.match(/(disabled|readOnly)=\{[^}]*\}/g) ?? []
      expect(locks.length, id).toBeGreaterThan(0)
      for (const lock of locks) {
        expect(lock, `${id}: ${lock} is not conditional on the invitation`).toContain('inviteEmail')
      }
    }
  })

  it('keeps the BankID field its own hint when there is no invitation', () => {
    expect(fieldGroup('bankid_email')).toContain("t('bankid_email_hint')")
  })
})

describe('the duplicate-email screen', () => {
  it('opens the e-mail form on /login, carrying only the method and the sanitized destination', () => {
    // buildLoginHref writes `method` and `next` (re-vetted through
    // safeReturnTo; /login?next=… when the signup started from the MCP
    // consent page, issue #1814) and nothing else.
    expect(duplicateScreen()).toContain("href={buildLoginHref({ method: 'password', next: nextPath })}")
    expect(CODE).toContain('const loginHref = buildLoginHref({ next: nextPath })')
  })

  it('hands the address to the login form through the tab, not the URL', () => {
    expect(duplicateScreen()).toContain('onClick={() => handOffLoginEmail(duplicateEmail)}')
    expect(duplicateScreen()).not.toMatch(/\/login\?/)
    expect(CODE).not.toMatch(/encodeURIComponent\((duplicateEmail|emailValue|bankIdEmail|email)\)/)
  })

  it('still shows the address on screen', () => {
    expect(duplicateScreen()).toContain('{duplicateEmail}')
  })
})

describe('"Logga in" when the signup finds an existing account (issue #209)', () => {
  /** One setFormError({...}) call, located by the message key it shows. */
  function formErrorFor(messageKey: string, from = 0): string {
    const anchor = CODE.indexOf(`message: t('${messageKey}')`, from)
    expect(anchor, `no setFormError for ${messageKey}`).toBeGreaterThan(-1)
    return CODE.slice(CODE.lastIndexOf('setFormError({', anchor), CODE.indexOf('})', anchor) + 2)
  }

  it('sends a BankID signup whose address has a password account to the e-mail form, with that address', () => {
    // BankID on /login would answer "no account": this BankID has none.
    const call = formErrorFor('account_exists_description')
    expect(call).toContain("signIn: { method: 'password', email: emailValue }")
  })

  it('sends a BankID that already has an account to BankID', () => {
    expect(formErrorFor('bankid_already_linked_description')).toContain("signIn: { method: 'bankid' }")
  })

  it('sends an e-mail signup for a taken address to the e-mail form, with that address', () => {
    expect(CODE).toMatch(
      /kind === 'email_exists'\s*\?\s*\{ signIn: \{ method: 'password' as const, email: emailValue \} \}/,
    )
  })

  it('renders the alert link from that choice, handing over the address on click', () => {
    const start = CODE.indexOf('formError.signIn ? (')
    expect(start).toBeGreaterThan(-1)
    const link = CODE.slice(start, CODE.indexOf('</Link>', start))
    expect(link).toContain('href={buildLoginHref({ method: formError.signIn.method, next: nextPath })}')
    expect(link).toContain('handOffLoginEmail(formError.signIn.email)')
  })
})

describe('the post-auth destination parameter', () => {
  it('reads `next` exactly once, and only through safeReturnTo', () => {
    // /login forwards `next` here for a visitor who arrived from the MCP
    // consent page without an account (issue #1814). The raw value must never
    // be consumed anywhere else on the page: every later use goes through
    // nextPath, which safeReturnTo has already vetted.
    expect(CODE.match(/searchParams\.get\('next'\)/g)).toHaveLength(1)
    expect(CODE).toContain("const nextPath = safeReturnTo(searchParams.get('next'), '/')")
  })

  it('only ever navigates to the vetted destination, never a raw parameter', () => {
    // Every hard navigation on the page targets nextPath or '/'.
    const targets = CODE.match(/window\.location\.(?:assign\([^)]*\)|href = [^\n]+)/g) ?? []
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      expect(target).toMatch(/^window\.location\.(?:assign\(nextPath\)|href = (?:nextPath|'\/'))$/)
    }
  })

  it('would have to sanitize a destination through safeReturnTo if one is ever added', () => {
    // The ratchet, not a restatement of today's behaviour: the moment someone
    // reads a destination off this URL, the shared validator has to be the
    // thing that vets it. Hand-rolled checks here emitted
    // `Location: http://evil.com/`. Rejection of absolute and
    // protocol-relative values is covered by
    // lib/auth/__tests__/safe-return-to.test.ts.
    const readsDestination = /searchParams\.get\('(next|returnTo|redirect|redirectTo)'\)/.test(CODE)
    if (readsDestination) {
      expect(CODE).toContain("from '@/lib/auth/safe-return-to'")
      expect(CODE).toMatch(/safeReturnTo\(\s*searchParams\.get\('(next|returnTo|redirect|redirectTo)'\)/)
    }
  })
})

describe('the wording the locked field renders', () => {
  const messages = (locale: 'sv' | 'en') =>
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../../messages/${locale}.json`), 'utf8'),
    ) as { register: Record<string, string> }

  for (const locale of ['sv', 'en'] as const) {
    it(`has both email hints in ${locale}.json`, () => {
      const register = messages(locale).register
      expect(register.invite_email_hint).toBeTruthy()
      expect(register.bankid_email_hint).toBeTruthy()
    })
  }
})
