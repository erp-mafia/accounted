import { describe, expect, it } from 'vitest'
import { sandboxTeardownOutcome } from '../cleanup-failure'

const USER = '00000000-0000-4000-8000-000000000001'

describe('sandboxTeardownOutcome', () => {
  it('keeps a sandbox user who has data in a real company', () => {
    expect(
      sandboxTeardownOutcome({
        user_id: USER,
        kind: 'sandbox',
        sqlstate: 'P0001',
        message: `User ${USER} has data in a company that is not a sandbox`,
        context: 'PL/pgSQL function cleanup_sandbox_user(uuid) line 30 at RAISE',
      }),
    ).toBe('kept')
  })

  it.each([
    ['a foreign key the teardown does not cover', {
      user_id: USER,
      kind: 'sandbox',
      sqlstate: '23503',
      message: 'update or delete on table "companies" violates foreign key constraint "x_company_id_fkey" on table "x"',
    }],
    ['the other guard of the same function', {
      user_id: USER,
      kind: 'sandbox',
      sqlstate: 'P0001',
      message: `User ${USER} is not a sandbox user`,
    }],
    ['the same words under another SQLSTATE', {
      user_id: USER,
      kind: 'sandbox',
      sqlstate: '57014',
      message: `User ${USER} has data in a company that is not a sandbox`,
    }],
    ['an orphaned auth user', {
      user_id: USER,
      kind: 'orphan',
      sqlstate: 'P0001',
      message: `User ${USER} has data in a company that is not a sandbox`,
    }],
    ['a failure with no reason at all', { user_id: USER }],
  ])('counts as failed: %s', (_name, failure) => {
    expect(sandboxTeardownOutcome(failure)).toBe('failed')
  })
})
