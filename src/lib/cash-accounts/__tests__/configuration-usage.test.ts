import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const service = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('@/tests/helpers').createTableMockSupabase> }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.db.supabase }))
const gateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/usage/gate', () => ({ bankAccountsSelectionRefusal: (...args: unknown[]) => gateMock(...args) }))

import { saveBankAccountSelection } from '../configuration'
import { errorResponse } from '@/lib/errors/get-structured-error'

const stored = [
  { uid: 'a', iban: 'SE11', enabled: true },
  { uid: 'b', iban: 'SE22', enabled: false, claimed_by_company_id: 'other' },
  { uid: 'c', iban: 'SE33', enabled: false },
]

function client() {
  const rpc = vi.fn().mockResolvedValue({ data: { status: 'active', accounts: [] }, error: null })
  return { rpc, supabase: { rpc } as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  service.db = createTableMockSupabase({ bank_connections: { data: { accounts_data: stored } } })
  gateMock.mockResolvedValue(null)
})

afterEach(() => {
  delete process.env.USAGE_BILLING_KINDS
})

describe('saveBankAccountSelection and the bank accounts the plan includes', () => {
  it('reads nothing while bank accounts are not billed', async () => {
    const { rpc, supabase } = client()
    await saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', [{ uid: 'a', currency: 'SEK', enabled: true }])
    expect(gateMock).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('counts the selection with its IBANs, an account switched on taken over from another company', async () => {
    process.env.USAGE_BILLING_KINDS = 'bank_account'
    const { supabase } = client()
    const selections = [
      { uid: 'a', currency: 'SEK', enabled: true },
      { uid: 'b', currency: 'SEK', enabled: true },
      { uid: 'c', currency: 'SEK', enabled: false },
    ]
    await saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', selections)
    expect(gateMock).toHaveBeenCalledWith(service.db.supabase, 'company', 'connection', [
      expect.objectContaining({ uid: 'a', iban: 'SE11', enabled: true }),
      expect.objectContaining({ uid: 'b', iban: 'SE22', enabled: true, claimed_by_company_id: null }),
      expect.objectContaining({ uid: 'c', iban: 'SE33', enabled: false }),
    ])
  })

  it('refuses before the save, with the sentence the picker shows', async () => {
    process.env.USAGE_BILLING_KINDS = 'bank_account'
    const messageSv = 'De 2 kopplade bankkonton som ingår är använda. Fler kostar 20,00 kr st i månaden. Begär fler under Inställningar, Abonnemang, Användning, så öppnar vi.'
    gateMock.mockResolvedValue({ ok: false, code: 'USAGE_LIMIT_REACHED', details: { kind: 'bank_account', used: 2, included: 2, requested: 1 }, messageSv })
    const { rpc, supabase } = client()

    const error = await saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', [{ uid: 'c', currency: 'SEK', enabled: true }]).catch(
      (err: unknown) => err,
    )

    expect(rpc).not.toHaveBeenCalled()
    const response = errorResponse(error, { error: () => {}, warn: () => {} } as never)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('USAGE_LIMIT_REACHED')
    expect(body.error.message).toBe(messageSv)
  })
})
