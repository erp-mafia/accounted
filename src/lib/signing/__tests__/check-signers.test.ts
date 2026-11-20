/**
 * The signer rules: nobody twice on an ordinary request, but one person may
 * hold two slots of an årsredovisning (styrelseledamot and VD), each its own
 * signature.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  hasBankIdLogin: vi.fn(async () => false),
}))

import { checkSigners } from '../requests'

const members = (ids: string[]) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: ids.map((user_id) => ({ user_id })), error: null }) }) }) }) }) as never

describe('checkSigners', () => {
  const twice = [
    { name: 'Anna Svensson', email: 'anna@example.se', userId: 'user-1', roleLabel: 'Styrelseledamot' },
    { name: 'Anna Svensson', email: 'anna@example.se', userId: 'user-1', roleLabel: 'VD' },
  ]

  it('refuses the same person twice on an ordinary request', async () => {
    expect(await checkSigners(members(['user-1']), 'company-1', twice)).toMatchObject({ ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'duplicate_email' } })
    expect(await checkSigners(members(['user-1']), 'company-1', twice.map((s) => ({ ...s, email: null })))).toMatchObject({
      ok: false,
      details: { reason: 'duplicate_member' },
    })
  })

  it('lets one person hold two årsredovisning slots', async () => {
    const outcome = await checkSigners(members(['user-1']), 'company-1', twice, { samePersonMaySignTwice: true })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.signers.map((s) => [s.position, s.roleLabel])).toEqual([[1, 'Styrelseledamot'], [2, 'VD']])
  })
})
