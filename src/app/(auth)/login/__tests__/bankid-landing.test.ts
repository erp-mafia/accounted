import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../login-client.tsx', import.meta.url)),
  'utf8',
)

function bankIdCompletionHandler(): string {
  const start = SOURCE.indexOf('const handleBankIdComplete')
  const end = SOURCE.indexOf('const handlePasswordLogin')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

describe('BankID login landing (crm#1034)', () => {
  it('lands where every sign-in lands, resolved by the shared helper', () => {
    // '/' opens the active company (the middleware resolves it from
    // user_preferences.active_company_id), byrå staff get the cockpit, and a
    // user without a company is sent on to the picker by the middleware.
    expect(bankIdCompletionHandler()).toContain('router.push(await resolvePostLoginDestination())')
  })

  it('never routes a sign-in to the company picker', () => {
    // The picker used to be the hardwired BankID landing, so a user whose
    // BankID lists a company they never added met it at every login.
    expect(SOURCE).not.toMatch(/router\.(push|replace)\([^)]*select-company/)
    expect(SOURCE).not.toMatch(/location\.(assign|replace)\([^)]*select-company/)
    expect(SOURCE).not.toMatch(/location\.href\s*=\s*[^;\n]*select-company/)
  })
})
