/**
 * Domain failures must carry a stable code, not just Swedish prose.
 *
 * `getStructuredError` resolves an error with no `code` to UNKNOWN_ERROR, whose
 * registry message is the constant "Något gick fel. Försök igen." An agent
 * branching on `code` therefore sees "unknown" even when the message it was
 * handed says exactly what to do.
 *
 * Production, 60 days, bot actors excluded: UNKNOWN_ERROR was 645 of 1 024
 * real-agent failures. 40 of those were gnubok_create_voucher refusing a
 * booking because the BAS accounts were not active in the company's chart, a
 * failure that already had a registry code (ACCOUNTS_NOT_IN_CHART) with a
 * remediation, and a message naming the two tools that fix it. The code was
 * simply never attached.
 *
 * The MCP server currently has ~155 bare `throw new Error('<Swedish prose>')`
 * against 3 uses of codedError(), so this is one instance of a broad pattern.
 * This file pins the instance that telemetry proved, and the shape any future
 * fix should follow.
 */
import { describe, it, expect } from 'vitest'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'

/** The exact shape extensions/general/mcp-server/server.ts now throws. */
function missingAccountsError(accounts: string[]) {
  return Object.assign(
    new Error(
      `Kan inte skapa verifikation. Konton saknas i kontoplanen och finns inte i BAS 2026: ${accounts.join(', ')}. ` +
        'Skapa kontot med gnubok_create_account, aktivera det med gnubok_update_account, eller välj andra konton.',
    ),
    { code: ACCOUNTS_NOT_IN_CHART, accountNumbers: accounts },
  )
}

describe('missing chart accounts is a dispatchable failure', () => {
  it('resolves to ACCOUNTS_NOT_IN_CHART, not UNKNOWN_ERROR', () => {
    expect(getStructuredError(missingAccountsError(['4010'])).code).toBe('ACCOUNTS_NOT_IN_CHART')
  })

  it('would have been UNKNOWN_ERROR without the code', () => {
    // The regression this pins. Same message, no code: an agent gets prose it
    // cannot branch on, which is what production showed for 40 calls.
    const uncoded = new Error(
      'Kan inte skapa verifikation. Konton saknas i kontoplanen och finns inte i BAS 2026: 4010.',
    )
    expect(getStructuredError(uncoded).code).toBe('UNKNOWN_ERROR')
  })

  it('carries the registry remediation the agent can act on', () => {
    const structured = getStructuredError(missingAccountsError(['3010']))
    expect(structured.remediation?.description ?? '').toMatch(/activate/i)
  })

  it('keeps the richer message that names the remedy tools', () => {
    // The registry's own text is the generic "Konton saknas i kontoplanen.".
    // The thrown message is better because it names both the accounts and the
    // tools, so it must survive being coded.
    const structured = getStructuredError(missingAccountsError(['7971']))
    const text = `${structured.message_sv} ${structured.message_en}`
    expect(text).toContain('gnubok_create_account')
    expect(text).toContain('7971')
  })
})
