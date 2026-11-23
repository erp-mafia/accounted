import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import {
  calculateConfidence,
  insertOrUpdateTemplate,
  unlearnCounterpartyTemplate,
  upsertCounterpartyTemplate,
  type TemplateUpsertParams,
} from '../counterparty-templates'
import { buildMappingResultFromCategory } from '../category-mapping'

/**
 * A learned single pair replays its stored moms (vat_treatment) on the next
 * row. A booking on the template's own accounts with another kind of moms is
 * the person saying the stored moms is wrong, as a booking on another account
 * says the stored account is wrong: the template follows the booking instead
 * of counting it as one more approval of the old moms. A reverse-charge
 * purchase from outside the EU teaches no pair (the replay would book the EU
 * basis, crm#1028), but it still takes an occurrence back from a habit it
 * rejects.
 */

const SAAS_PAIR = { debit_account: '5420', credit_account: '1930' }

function reverseChargePurchase(merchant: string, kind: 'eu_services' | 'non_eu_services', costAccount: string) {
  const tx = makeTransaction({ merchant_name: merchant, amount: -250, date: '2026-11-03' })
  const booked = buildMappingResultFromCategory('expense_software', tx, true, 'aktiebolag', 'reverse_charge', null, null, kind)
  booked.debit_account = costAccount
  return { tx, booked }
}

describe('insertOrUpdateTemplate: the moms of a booking on the template\'s own pair', () => {
  const params: TemplateUpsertParams = {
    counterpartyName: 'saas vendor',
    aliases: ['saas vendor'],
    debitAccount: '5420',
    creditAccount: '1930',
    vatTreatment: 'reverse_charge',
    vatAccount: '2645',
    category: null,
    occurrenceCount: 1,
    confidence: 0.45,
    lastSeenDate: '2026-11-03',
    source: 'user_approved',
  }

  async function learn(existing: ReturnType<typeof makeCategorizationTemplate>, overrides: Partial<TemplateUpsertParams> = {}) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // update
    await insertOrUpdateTemplate(supabase as never, 'company-1', { ...params, ...overrides }, existing)
    const [payload] = findCalls('categorization_templates', 'update')[0] as [Record<string, unknown>]
    return payload
  }

  it('reverse charge on a pair learned without moms is a correction: the template takes the booked moms', async () => {
    const payload = await learn(makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: null, vat_account: null, occurrence_count: 3, corrections: 0 }))
    expect(payload).toMatchObject({ vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 1, corrections: 1 })
  })

  it('a rate on a reverse-charge pair is a correction', async () => {
    const payload = await learn(
      makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 2, corrections: 0 }),
      { vatTreatment: 'standard_25', vatAccount: '2641' },
    )
    expect(payload).toMatchObject({ vat_treatment: 'standard_25', vat_account: '2641', occurrence_count: 1, corrections: 1 })
  })

  it('a booking without moms is a correction of a reverse-charge pair', async () => {
    const payload = await learn(
      makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 2, corrections: 0 }),
      { vatTreatment: null, vatAccount: null },
    )
    expect(payload).toMatchObject({ vat_treatment: null, occurrence_count: 1, corrections: 1 })
  })

  it('a booking without moms re-approves a rated pair: a company not VAT-registered replays it without moms', async () => {
    const payload = await learn(
      makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: 'standard_25', vat_account: '2641', occurrence_count: 8, corrections: 0 }),
      { vatTreatment: null, vatAccount: null },
    )
    expect(payload.occurrence_count).toBe(9)
    expect(payload).not.toHaveProperty('corrections')
    expect(payload).not.toHaveProperty('vat_treatment')
  })

  it('another rate is not compared: an underlag\'s moms amount states no rate and reads as 25 %', async () => {
    const payload = await learn(
      makeCategorizationTemplate({ debit_account: '5800', credit_account: '1930', vat_treatment: 'reduced_12', vat_account: '2641', occurrence_count: 6, corrections: 0 }),
      { debitAccount: '5800', vatTreatment: 'standard_25', vatAccount: '2641' },
    )
    expect(payload.occurrence_count).toBe(7)
    expect(payload).not.toHaveProperty('vat_treatment')
  })

  it('the same moms on the same accounts stays a re-approval', async () => {
    const payload = await learn(makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 3, corrections: 0 }))
    expect(payload.occurrence_count).toBe(4)
    expect(payload).not.toHaveProperty('corrections')
    expect(payload).not.toHaveProperty('vat_treatment')
  })

  it('an SIE import with other moms on the same accounts stays a re-approval: history does not overrule a booking', async () => {
    const payload = await learn(
      makeCategorizationTemplate({ ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 2, corrections: 0, source: 'user_approved' }),
      { vatTreatment: null, vatAccount: null, source: 'sie_import', occurrenceCount: 5 },
    )
    expect(payload.occurrence_count).toBe(7)
    expect(payload).not.toHaveProperty('vat_treatment')
  })

  it('a pattern template replays the moms of its pattern, so its moms field is not compared', async () => {
    const payload = await learn(
      makeCategorizationTemplate({
        ...SAAS_PAIR,
        vat_treatment: null,
        vat_account: null,
        occurrence_count: 3,
        corrections: 0,
        line_pattern: [
          { account: '5420', side: 'debit', type: 'business', ratio: 0.8 },
          { account: '2641', side: 'debit', type: 'vat', ratio: 0.2, vat_rate: 0.25 },
          { account: '1930', side: 'credit', type: 'settlement', ratio: 1 },
        ] as never,
      }),
    )
    expect(payload.occurrence_count).toBe(4)
    expect(payload).not.toHaveProperty('corrections')
  })
})

describe('upsertCounterpartyTemplate: a booking whose moms contradicts the learned pair', () => {
  it('an EU reverse-charge purchase on a pair learned without moms teaches the template reverse charge', async () => {
    const { tx, booked } = reverseChargePurchase('ANTHROPIC IRELAND', 'eu_services', '5420')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'anthropic ireland', ...SAAS_PAIR, vat_treatment: null, vat_account: null, occurrence_count: 2 }) })
    enqueue({ data: null }) // update

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    const [payload] = findCalls('categorization_templates', 'update')[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ vat_treatment: 'reverse_charge', occurrence_count: 1, corrections: 1 })
  })

  it('a reverse-charge purchase from outside the EU takes an occurrence back from a template on another account without moms', async () => {
    const { tx, booked } = reverseChargePurchase('CLOUDFLARE', 'non_eu_services', '5420')
    expect(booked.vat_lines.map((l) => l.account_number)).toContain('4531')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ id: 'tmpl-cf', counterparty_name: 'cloudflare', debit_account: '6110', credit_account: '1930', vat_treatment: null, occurrence_count: 2 }) })
    enqueue({ data: null }) // update

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toEqual([[{ occurrence_count: 1, confidence: calculateConfidence(1) }]])
    expect(findCalls('categorization_templates', 'eq')).toContainEqual(['id', 'tmpl-cf'])
    expect(findCalls('categorization_templates', 'insert')).toHaveLength(0)
  })

  it('switches off a template on the same account without moms when its last occurrence comes off', async () => {
    const { tx, booked } = reverseChargePurchase('GitHub', 'non_eu_services', '5420')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: null, occurrence_count: 1 }) })
    enqueue({ data: null }) // update

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toEqual([[{ is_active: false }]])
  })

  it('a habit with a long history loses one occurrence, not the template', async () => {
    const { tx, booked } = reverseChargePurchase('ATLASSIAN', 'non_eu_services', '5420')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'atlassian', ...SAAS_PAIR, vat_treatment: null, occurrence_count: 10 }) })
    enqueue({ data: null }) // update

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toEqual([[{ occurrence_count: 9, confidence: calculateConfidence(9) }]])
  })

  it('leaves a reverse-charge template on another account: it may be right for the same name\'s EU purchases', async () => {
    const { tx, booked } = reverseChargePurchase('GOOGLE', 'non_eu_services', '6540')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'google', ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 1 }) })

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toHaveLength(0)
  })

  it('leaves a template that already books reverse charge on the same account', async () => {
    const { tx, booked } = reverseChargePurchase('GitHub', 'non_eu_services', '5420')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645' }) })

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toHaveLength(0)
    expect(findCalls('categorization_templates', 'insert')).toHaveLength(0)
  })

  it('leaves a rule the person set to book on its own, and a switched-off template', async () => {
    for (const held of [{ mode: 'auto' as const }, { is_active: false }]) {
      const { tx, booked } = reverseChargePurchase('GitHub', 'non_eu_services', '5420')
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: null, ...held }) })

      await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

      expect(findCalls('categorization_templates', 'update')).toHaveLength(0)
    }
  })

  it('writes nothing when no template holds the counterparty', async () => {
    const { tx, booked } = reverseChargePurchase('GitHub', 'non_eu_services', '5420')
    const { supabase, findCalls } = createQueuedMockSupabase()

    await upsertCounterpartyTemplate(supabase as never, 'company-1', tx, booked, 'user_approved')

    expect(findCalls('categorization_templates', 'update')).toHaveLength(0)
    expect(findCalls('categorization_templates', 'insert')).toHaveLength(0)
  })
})

describe('unlearnCounterpartyTemplate: only what the template holds now', () => {
  const BANK_ROW = { merchant_name: 'GitHub', original_description: 'GitHub', description: 'GitHub' }
  const WITHOUT_MOMS = [
    { account_number: '5420', debit_amount: 40.72, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 40.72 },
  ]

  it('an old booking without moms does not switch off a template since corrected to reverse charge', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: 'reverse_charge', vat_account: '2645', occurrence_count: 1 }) })

    const outcome = await unlearnCounterpartyTemplate(supabase as never, 'company-1', BANK_ROW, WITHOUT_MOMS)

    expect(outcome).toBeNull()
    expect(findCalls('categorization_templates', 'update')).toHaveLength(0)
  })

  it('a booking without moms still takes its occurrence back from a template without moms', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: null, occurrence_count: 1 }) })
    enqueue({ data: null }) // update

    expect(await unlearnCounterpartyTemplate(supabase as never, 'company-1', BANK_ROW, WITHOUT_MOMS)).toBe('deactivated')
  })

  it('a booking without moms takes its occurrence back from a rated template (a company not VAT-registered)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', ...SAAS_PAIR, vat_treatment: 'standard_25', vat_account: '2641', occurrence_count: 4 }) })
    enqueue({ data: null }) // update

    expect(await unlearnCounterpartyTemplate(supabase as never, 'company-1', BANK_ROW, WITHOUT_MOMS)).toBe('decremented')
  })

  it('the pair\'s own accounts are not read as moms: a template booked on a moms account is still unlearned', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeCategorizationTemplate({ counterparty_name: 'github', debit_account: '2641', credit_account: '1930', vat_treatment: null, vat_account: null, occurrence_count: 2 }) })
    enqueue({ data: null }) // update

    const lines = [
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ]
    expect(await unlearnCounterpartyTemplate(supabase as never, 'company-1', BANK_ROW, lines)).toBe('decremented')
  })
})
