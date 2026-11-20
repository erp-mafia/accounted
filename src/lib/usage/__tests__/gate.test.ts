import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const countMock = vi.hoisted(() => vi.fn())
vi.mock('../counters', () => ({ countCompanyUsage: (...args: unknown[]) => countMock(...args) }))

import { bankAccountsSelectionRefusal, usageGateRefusal, usageLimitReachedMessage } from '../gate'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const BILLED = { USAGE_BILLING_KINDS: 'peppol_send' }

const ACTIVE = { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }

function db(consents: unknown[] = [], subscription: unknown = ACTIVE, extra: Record<string, { data: unknown }> = {}) {
  return createTableMockSupabase({
    usage_consents: { data: consents },
    company_subscriptions: { data: subscription },
    company_settings: { data: { is_sandbox: false } },
    ...extra,
  }).supabase as unknown as SupabaseClient
}

/** Signed documents are included once: `before` earlier months' signings, `month` this month's. */
function signings(before: number, month: number) {
  countMock.mockImplementation(async (_db: unknown, _company: string, _kind: string, _period: string, options?: { before?: boolean }) =>
    options?.before ? before : month,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usageGateRefusal', () => {
  it('never stops a kind that is not billed, and reads nothing for it', async () => {
    expect(await usageGateRefusal(db(), COMPANY, 'peppol_send', { env: {} })).toBeNull()
    expect(countMock).not.toHaveBeenCalled()
  })

  it('lets a send within what the month includes through, the last included one too', async () => {
    countMock.mockResolvedValue(9)
    expect(await usageGateRefusal(db(), COMPANY, 'peppol_send', { env: BILLED, period: '2026-11' })).toBeNull()
  })

  it('stops the first send above what is included until the charge is open, with the numbers and where to ask for more', async () => {
    countMock.mockResolvedValue(10)
    expect(await usageGateRefusal(db(), COMPANY, 'peppol_send', { env: BILLED, period: '2026-11' })).toEqual({
      ok: false,
      code: 'USAGE_LIMIT_REACHED',
      details: { kind: 'peppol_send', period: '2026-11', used: 10, included: 10, requested: 1, unit_price_ore: 100 },
      messageSv:
        'Månadens 10 e-fakturor via Peppol som ingår är använda. Fler kostar 1,00 kr st. Begär fler under Inställningar, Abonnemang, Användning, så öppnar vi.',
    })
  })

  it('asks for nothing when nothing more is requested', async () => {
    expect(await usageGateRefusal(db(), COMPANY, 'peppol_send', { env: BILLED, used: 40, requested: 0 })).toBeNull()
    expect(countMock).not.toHaveBeenCalled()
  })

  it('lets it through once the charge is open at today\'s price, and not at a lower one', async () => {
    countMock.mockResolvedValue(25)
    const accepted = [{ company_id: COMPANY, kind: 'peppol_send', unit_price_ore: 100, included: 10, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    expect(await usageGateRefusal(db(accepted), COMPANY, 'peppol_send', { env: BILLED })).toBeNull()
    const cheaper = [{ ...accepted[0], unit_price_ore: 50 }]
    expect(await usageGateRefusal(db(cheaper), COMPANY, 'peppol_send', { env: BILLED })).toMatchObject({ code: 'USAGE_LIMIT_REACHED' })
  })

  it('treats a byrå client covered by its byrå\'s agreement as paid for: it can be opened', async () => {
    signings(0, 3)
    const byra = {
      companies: { data: { team_id: 'team-1' } },
      teams: { data: { name: 'Byrån AB', kind: 'byra' } },
      capability_grants: { data: [{ expires_at: null }] },
    }
    const env = { USAGE_BILLING_KINDS: 'signing' }
    expect(await usageGateRefusal(db([], null, byra), COMPANY, 'signing', { env })).toMatchObject({ code: 'USAGE_LIMIT_REACHED' })
    const open = [{ company_id: COMPANY, kind: 'signing', unit_price_ore: 1000, included: 3, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    expect(await usageGateRefusal(db(open, null, byra), COMPANY, 'signing', { env })).toBeNull()
  })
})

describe('usageGateRefusal without a subscription of its own', () => {
  it('stops a trial at what is included, accepted or not, and says a subscription is needed', async () => {
    signings(2, 1)
    const trial = { ...ACTIVE, status: 'trialing' }
    const accepted = [{ company_id: COMPANY, kind: 'signing', unit_price_ore: 1000, included: 3, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    const refusal = await usageGateRefusal(db(accepted, trial), COMPANY, 'signing', { env: { USAGE_BILLING_KINDS: 'signing' }, period: '2026-11' })
    expect(refusal).toEqual({
      ok: false,
      code: 'USAGE_SUBSCRIPTION_REQUIRED',
      details: { kind: 'signing', period: '2026-11', used: 3, included: 3, requested: 1, unit_price_ore: 1000 },
      messageSv:
        'De 3 signeringar som ingår är använda. Fler kostar 10,00 kr st och kräver ett abonnemang. Starta det under Inställningar, Abonnemang.',
    })
  })

  it('stops a company with no subscription row, and lets it use what is included', async () => {
    signings(0, 2)
    const env = { USAGE_BILLING_KINDS: 'signing' }
    expect(await usageGateRefusal(db([], null), COMPANY, 'signing', { env })).toBeNull()
    signings(1, 2)
    expect(await usageGateRefusal(db([], null), COMPANY, 'signing', { env })).toMatchObject({ code: 'USAGE_SUBSCRIPTION_REQUIRED' })
  })
})

describe('usageGateRefusal for signed documents, included once', () => {
  const env = { USAGE_BILLING_KINDS: 'signing' }

  it('counts the company\'s signings in all, so a new month gives no new ones', async () => {
    signings(3, 0)
    expect(await usageGateRefusal(db(), COMPANY, 'signing', { env, period: '2026-12' })).toEqual({
      ok: false,
      code: 'USAGE_LIMIT_REACHED',
      details: { kind: 'signing', period: '2026-12', used: 3, included: 3, requested: 1, unit_price_ore: 1000 },
      messageSv: 'De 3 signeringar som ingår är använda. Fler kostar 10,00 kr st. Begär fler under Inställningar, Abonnemang, Användning, så öppnar vi.',
    })
    expect(countMock).toHaveBeenCalledWith(expect.anything(), COMPANY, 'signing', '2026-12', { before: true })
  })

  it('lets the third in all through, whichever months the first two fell in', async () => {
    signings(1, 1)
    expect(await usageGateRefusal(db(), COMPANY, 'signing', { env, period: '2026-12' })).toBeNull()
  })
})

describe('usageGateRefusal for Kivra', () => {
  it('stops the first send of a month: none is included', async () => {
    countMock.mockResolvedValue(0)
    expect(await usageGateRefusal(db(), COMPANY, 'kivra_send', { env: { USAGE_BILLING_KINDS: 'kivra_send' }, period: '2026-12' })).toEqual({
      ok: false,
      code: 'USAGE_LIMIT_REACHED',
      details: { kind: 'kivra_send', period: '2026-12', used: 0, included: 0, requested: 1, unit_price_ore: 300 },
      messageSv: 'Utskick till Kivra kostar 3,00 kr st. Begär det under Inställningar, Abonnemang, Användning, så öppnar vi.',
    })
  })

  it('takes a whole payslip run as what is requested', async () => {
    countMock.mockResolvedValue(4)
    const accepted = [{ company_id: COMPANY, kind: 'kivra_send', unit_price_ore: 300, included: 0, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    const env = { USAGE_BILLING_KINDS: 'kivra_send' }
    expect(await usageGateRefusal(db(accepted), COMPANY, 'kivra_send', { env, requested: 6 })).toBeNull()
    expect(await usageGateRefusal(db(), COMPANY, 'kivra_send', { env, requested: 6 })).toMatchObject({ details: { requested: 6, used: 4 } })
  })
})

describe('usageLimitReachedMessage', () => {
  it('names the units of each kind', () => {
    expect(
      usageLimitReachedMessage({ kind: 'bank_payment', period: '2026-11', used: 10, included: 10, requested: 2, unit_price_ore: 200 }),
    ).toMatch(/^Månadens 10 bankbetalningar som ingår är använda\. Fler kostar 2,00 kr st\. Begär fler/)
  })

  it('says a bank account costs per month, not per month used', () => {
    expect(usageLimitReachedMessage({ kind: 'bank_account', period: '2026-11', used: 2, included: 2, requested: 1, unit_price_ore: 2000 })).toBe(
      'De 2 kopplade bankkonton som ingår är använda. Fler kostar 20,00 kr st i månaden. Begär fler under Inställningar, Abonnemang, Användning, så öppnar vi.',
    )
  })
})

describe('bankAccountsSelectionRefusal', () => {
  const env = { USAGE_BILLING_KINDS: 'bank_account' }
  const account = (uid: string, iban: string, enabled = true) => ({ uid, iban, enabled })
  // Two live accounts on the company's older connection: what the plan includes.
  const connections = { bank_connections: { data: [{ id: 'conn-old', accounts_data: [account('a', 'SE11 0000'), account('b', 'SE22 0000')] }] } }

  it('reads nothing while bank accounts are not billed', async () => {
    expect(await bankAccountsSelectionRefusal(db([], ACTIVE, connections), COMPANY, 'conn-new', [account('c', 'SE33 0000')], { env: {} })).toBeNull()
  })

  it('stops a third account, counted once whatever connection carries it', async () => {
    const refusal = await bankAccountsSelectionRefusal(
      db([], ACTIVE, connections),
      COMPANY,
      'conn-new',
      [account('a2', 'SE110000'), account('c', 'SE33 0000')],
      { env },
    )
    expect(refusal).toMatchObject({ code: 'USAGE_LIMIT_REACHED', details: { kind: 'bank_account', used: 2, requested: 1, included: 2 } })
  })

  it('lets a reconnect of the same accounts, and a deselection, through', async () => {
    expect(await bankAccountsSelectionRefusal(db([], ACTIVE, connections), COMPANY, 'conn-new', [account('a2', 'SE110000'), account('b2', 'SE220000')], { env })).toBeNull()
    expect(await bankAccountsSelectionRefusal(db([], ACTIVE, connections), COMPANY, 'conn-old', [account('a', 'SE11 0000'), account('b', 'SE22 0000', false)], { env })).toBeNull()
  })

  it('keeps a company above what is included where it is: only an added account stops', async () => {
    const four = { bank_connections: { data: [{ id: 'conn-old', accounts_data: ['1', '2', '3', '4'].map((n) => account(n, `SE${n}`)) }] } }
    const same = ['1', '2', '3', '4'].map((n) => account(n, `SE${n}`))
    expect(await bankAccountsSelectionRefusal(db([], ACTIVE, four), COMPANY, 'conn-old', same, { env })).toBeNull()
    expect(await bankAccountsSelectionRefusal(db([], ACTIVE, four), COMPANY, 'conn-old', [...same, account('5', 'SE5')], { env })).toMatchObject({
      details: { used: 4, requested: 1 },
    })
  })
})
