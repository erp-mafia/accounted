import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasForeignCredential,
  isUnadoptedPendingAccount,
  revokePendingIdentity,
} from '../lib/bankid-pending'

function identity(provider: string) {
  return { provider } as unknown as NonNullable<
    Parameters<typeof hasForeignCredential>[0]['identities']
  >[number]
}

describe('hasForeignCredential', () => {
  it('is false for the shell a BankID signup makes (email identity, no password)', () => {
    expect(
      hasForeignCredential({
        identities: [identity('email')],
        app_metadata: { bankid_pending: true, has_password: false },
        email_confirmed_at: undefined,
      }),
    ).toBe(false)
  })

  it('is false when identities are absent altogether', () => {
    expect(hasForeignCredential({ app_metadata: {} })).toBe(false)
  })

  it('is true once a Google identity is attached', () => {
    expect(
      hasForeignCredential({
        identities: [identity('email'), identity('google')],
        app_metadata: { bankid_pending: true },
      }),
    ).toBe(true)
  })

  it('is true once the user has set a password themselves', () => {
    expect(
      hasForeignCredential({
        identities: [identity('email')],
        app_metadata: { bankid_pending: true, has_password: true },
      }),
    ).toBe(true)
  })
})

describe('isUnadoptedPendingAccount', () => {
  it('is true only while the address is unconfirmed and no foreign credential exists', () => {
    expect(
      isUnadoptedPendingAccount({
        identities: [identity('email')],
        app_metadata: { bankid_pending: true, has_password: false },
        email_confirmed_at: undefined,
      }),
    ).toBe(true)
  })

  it('is false once the address was confirmed by any means', () => {
    // A confirmed account is never deleted on re-signup, even without a
    // foreign credential: the old flow admin-confirmed addresses it never
    // proved, and those accounts may have data.
    expect(
      isUnadoptedPendingAccount({
        identities: [identity('email')],
        app_metadata: { bankid_linked: true },
        email_confirmed_at: '2026-08-01T00:00:00Z',
      }),
    ).toBe(false)
  })

  it('is false when a foreign credential exists even if unconfirmed', () => {
    expect(
      isUnadoptedPendingAccount({
        identities: [identity('email')],
        app_metadata: { has_password: true },
        email_confirmed_at: undefined,
      }),
    ).toBe(false)
  })
})

describe('revokePendingIdentity', () => {
  const updateUserById = vi.fn()
  const calls: Array<{ method: string; args: unknown[] }> = []
  let deleteResult: { error: { code?: string; message: string } | null }

  function chain(): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(deleteResult)
          }
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return chain()
          }
        },
      },
    )
  }

  const supabase = {
    from: vi.fn(() => chain()),
    auth: { admin: { updateUserById } },
  } as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    deleteResult = { error: null }
    updateUserById.mockResolvedValue({ data: {}, error: null })
  })

  it('deletes only unverified rows for the user and drops bankid_pending, keeping the rest of app_metadata', async () => {
    const ok = await revokePendingIdentity(supabase, 'user-1', {
      bankid_pending: true,
      has_password: true,
      provider: 'email',
    })

    expect(ok).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('bankid_identities')
    expect(calls.map((c) => c.method)).toEqual(['delete', 'eq', 'is'])
    expect(calls[1].args).toEqual(['user_id', 'user-1'])
    expect(calls[2].args).toEqual(['email_verified_at', null])
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { bankid_pending: null, has_password: true, provider: 'email' },
    })
    // Never grants the MFA exemption on the way out.
    const written = updateUserById.mock.calls[0][1].app_metadata as Record<string, unknown>
    expect(written.bankid_linked).toBeUndefined()
  })

  it('returns false and leaves app_metadata alone when the delete fails', async () => {
    deleteResult = { error: { code: 'XX000', message: 'boom' } }

    const ok = await revokePendingIdentity(supabase, 'user-1', { bankid_pending: true })

    expect(ok).toBe(false)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('tolerates missing prior metadata', async () => {
    const ok = await revokePendingIdentity(supabase, 'user-1', undefined)

    expect(ok).toBe(true)
    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { bankid_pending: null },
    })
  })
})
