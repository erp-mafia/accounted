import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const countMock = vi.hoisted(() => vi.fn())
vi.mock('../counters', () => ({ countCompanyUsage: (...args: unknown[]) => countMock(...args) }))

import { usageConsentRequiredMessage, usageGateRefusal } from '../gate'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const BILLED = { USAGE_BILLING_KINDS: 'peppol_send' }

const ACTIVE = { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }

function db(consents: unknown[] = [], subscription: unknown = ACTIVE) {
  return createTableMockSupabase({
    usage_consents: { data: consents },
    company_subscriptions: { data: subscription },
    company_settings: { data: { is_sandbox: false } },
  }).supabase as unknown as SupabaseClient
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

  it('stops the first send above what is included until an admin accepts, with the numbers and the Swedish sentence', async () => {
    countMock.mockResolvedValue(10)
    expect(await usageGateRefusal(db(), COMPANY, 'peppol_send', { env: BILLED, period: '2026-11' })).toEqual({
      ok: false,
      code: 'USAGE_CONSENT_REQUIRED',
      details: { kind: 'peppol_send', period: '2026-11', used: 10, included: 10, requested: 1, unit_price_ore: 100 },
      messageSv:
        'Månadens 10 e-fakturor via Peppol som ingår är använda. Fler kostar 1,00 kr st och faktureras i efterskott. En admin godkänner det under Inställningar, Abonnemang, Användning.',
    })
  })

  it('lets it through once accepted at today\'s price, and not at a lower one', async () => {
    countMock.mockResolvedValue(25)
    const accepted = [{ company_id: COMPANY, kind: 'peppol_send', unit_price_ore: 100, included: 10, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    expect(await usageGateRefusal(db(accepted), COMPANY, 'peppol_send', { env: BILLED })).toBeNull()
    const cheaper = [{ ...accepted[0], unit_price_ore: 50 }]
    expect(await usageGateRefusal(db(cheaper), COMPANY, 'peppol_send', { env: BILLED })).toMatchObject({ code: 'USAGE_CONSENT_REQUIRED' })
  })
})

describe('usageGateRefusal without a subscription of its own', () => {
  it('stops a trial at what is included, accepted or not, and says a subscription is needed', async () => {
    countMock.mockResolvedValue(3)
    const trial = { ...ACTIVE, status: 'trialing' }
    const accepted = [{ company_id: COMPANY, kind: 'signing', unit_price_ore: 1000, included: 3, accepted_by: 'u1', accepted_at: '2026-11-02T08:00:00Z' }]
    const refusal = await usageGateRefusal(db(accepted, trial), COMPANY, 'signing', { env: { USAGE_BILLING_KINDS: 'signing' }, period: '2026-11' })
    expect(refusal).toEqual({
      ok: false,
      code: 'USAGE_SUBSCRIPTION_REQUIRED',
      details: { kind: 'signing', period: '2026-11', used: 3, included: 3, requested: 1, unit_price_ore: 1000 },
      messageSv:
        'Månadens 3 signeringar som ingår är använda. Fler kostar 10,00 kr st och kräver ett abonnemang. Starta det under Inställningar, Abonnemang.',
    })
  })

  it('stops a company with no subscription row, and lets it use what is included', async () => {
    countMock.mockResolvedValue(2)
    const env = { USAGE_BILLING_KINDS: 'signing' }
    expect(await usageGateRefusal(db([], null), COMPANY, 'signing', { env })).toBeNull()
    countMock.mockResolvedValue(3)
    expect(await usageGateRefusal(db([], null), COMPANY, 'signing', { env })).toMatchObject({ code: 'USAGE_SUBSCRIPTION_REQUIRED' })
  })
})

describe('usageGateRefusal for Kivra', () => {
  it('stops the first send of a month: none is included', async () => {
    countMock.mockResolvedValue(0)
    expect(await usageGateRefusal(db(), COMPANY, 'kivra_send', { env: { USAGE_BILLING_KINDS: 'kivra_send' }, period: '2026-12' })).toEqual({
      ok: false,
      code: 'USAGE_CONSENT_REQUIRED',
      details: { kind: 'kivra_send', period: '2026-12', used: 0, included: 0, requested: 1, unit_price_ore: 300 },
      messageSv: 'Utskick till Kivra kostar 3,00 kr st och faktureras i efterskott. En admin godkänner det under Inställningar, Abonnemang, Användning.',
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

describe('usageConsentRequiredMessage', () => {
  it('names the units of each kind', () => {
    expect(
      usageConsentRequiredMessage({ kind: 'bank_payment', period: '2026-11', used: 10, included: 10, requested: 2, unit_price_ore: 200 }),
    ).toMatch(/^Månadens 10 bankbetalningar som ingår är använda\. Fler kostar 2,00 kr st/)
  })
})
