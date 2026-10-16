import { describe, it, expect, vi } from 'vitest'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import {
  calculateConfidence,
  findCounterpartyTemplatesBatch,
  insertOrUpdateTemplate,
  normalizeCounterpartyName,
  unlearnCounterpartyTemplate,
  upsertCounterpartyTemplate,
  type TemplateUpsertParams,
} from '../counterparty-templates'
import type { CategorizationTemplate, MappingResult } from '@/types'

/**
 * crm#1275: a Skatteverket payment booked by mistake as 5890 with 25 % moms
 * and undone two seconds later was learned anyway, and came back as the
 * row's proposal. These cover the three places that let it: learning and
 * matching Skatteverket payments, a correction that kept the old moms, and
 * a reversal that left what the booking taught.
 */

/** A categorization_templates table over fixed rows that records its writes. */
function templateTable(rows: CategorizationTemplate[]) {
  const updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }> = []
  const inserts: Record<string, unknown>[] = []
  const from = vi.fn(() => {
    const filters: Record<string, unknown> = {}
    let alias: string | null = null
    const matching = () =>
      rows.filter((r) =>
        Object.entries(filters).every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val) &&
        (alias === null || (r.counterparty_aliases ?? []).includes(alias)),
      )
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return chain
      },
      contains: (_col: string, val: string[]) => {
        alias = val[0]
        return chain
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: { data: CategorizationTemplate[]; error: null }) => void) =>
        resolve({ data: matching(), error: null }),
      update: (payload: Record<string, unknown>) => {
        const updateFilters: Record<string, unknown> = {}
        const updateChain = {
          eq: (col: string, val: unknown) => {
            updateFilters[col] = val
            return updateChain
          },
          then: (resolve: (v: { error: null }) => void) => {
            updates.push({ payload, filters: updateFilters })
            resolve({ error: null })
          },
        }
        return updateChain
      },
      insert: async (payload: Record<string, unknown>) => {
        inserts.push(payload)
        return { error: null }
      },
    }
    return chain
  })
  return { supabase: { from } as never, from, updates, inserts }
}

const SKV_TEXT = 'SKATTEVERKET     BG 0000050501055 Bg-bet. via internet'
const skvPayment = () =>
  makeTransaction({ amount: -12225, merchant_name: null, description: SKV_TEXT, original_description: SKV_TEXT })
const SKV_KEY = normalizeCounterpartyName(SKV_TEXT)

const travelWithVat: MappingResult = {
  rule: null,
  debit_account: '5890',
  credit_account: '1930',
  risk_level: 'NONE',
  confidence: 0.9,
  requires_review: false,
  default_private: false,
  vat_lines: [{ account_number: '2641', debit_amount: 2445, credit_amount: 0, description: 'Ingående moms 25%' }],
  description: 'SKATTEVERKET',
}

describe('learning a payment to Skatteverket', () => {
  it('learns nothing from it, whatever it was booked on', async () => {
    const table = templateTable([])
    await upsertCounterpartyTemplate(table.supabase, 'company-1', skvPayment(), travelWithVat, 'user_approved')
    expect(table.from).not.toHaveBeenCalled()
    expect(table.inserts).toHaveLength(0)
  })

  it('never offers a template learned from one, while other rows still match theirs', async () => {
    const skvTemplate = makeCategorizationTemplate({
      counterparty_name: SKV_KEY,
      counterparty_aliases: [SKV_TEXT.toLowerCase()],
      debit_account: '5890',
    })
    const telia = makeCategorizationTemplate()
    const table = templateTable([skvTemplate, telia])
    const teliaTx = makeTransaction({ merchant_name: 'Telia Sverige AB', amount: -500 })
    const skvTx = skvPayment()

    const matches = await findCounterpartyTemplatesBatch(table.supabase, 'company-1', [skvTx, teliaTx])

    expect(matches.get(teliaTx.id)?.template.id).toBe(telia.id)
    expect(matches.has(skvTx.id)).toBe(false)
  })
})

describe('correcting a learned template', () => {
  it('clears the moms when the corrected pair books none', async () => {
    const existing = makeCategorizationTemplate({
      debit_account: '5890',
      credit_account: '1930',
      vat_treatment: 'standard_25',
      vat_account: '2641',
    })
    const table = templateTable([existing])
    const params: TemplateUpsertParams = {
      counterpartyName: existing.counterparty_name,
      aliases: [],
      debitAccount: '1630',
      creditAccount: '1930',
      vatTreatment: null,
      vatAccount: null,
      category: null,
      occurrenceCount: 1,
      confidence: calculateConfidence(1),
      lastSeenDate: '2026-10-16',
      source: 'user_approved',
    }

    await insertOrUpdateTemplate(table.supabase, 'company-1', params, existing)

    expect(table.updates).toHaveLength(1)
    expect(table.updates[0].payload).toMatchObject({
      debit_account: '1630',
      vat_treatment: null,
      vat_account: null,
    })
  })
})

describe('unlearnCounterpartyTemplate', () => {
  const bankLine = makeTransaction({ merchant_name: null, description: SKV_TEXT, original_description: SKV_TEXT })
  const reversedLines = [
    { account_number: '2641', debit_amount: 2445, credit_amount: 0 },
    { account_number: '5890', debit_amount: 9780, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 12225 },
  ]
  const learned = (overrides: Partial<CategorizationTemplate> = {}) =>
    makeCategorizationTemplate({
      counterparty_name: SKV_KEY,
      counterparty_aliases: [SKV_TEXT.toLowerCase()],
      debit_account: '5890',
      credit_account: '1930',
      occurrence_count: 1,
      ...overrides,
    })

  it('switches off a template that booking alone taught', async () => {
    const template = learned()
    const table = templateTable([template])

    const outcome = await unlearnCounterpartyTemplate(table.supabase, 'company-1', bankLine, reversedLines)

    expect(outcome).toBe('deactivated')
    expect(table.updates).toEqual([
      { payload: { is_active: false }, filters: { id: template.id, company_id: 'company-1' } },
    ])
  })

  it('takes one occurrence off a template other bookings taught too', async () => {
    const table = templateTable([learned({ occurrence_count: 4 })])

    const outcome = await unlearnCounterpartyTemplate(table.supabase, 'company-1', bankLine, reversedLines)

    expect(outcome).toBe('decremented')
    expect(table.updates[0].payload).toEqual({ occurrence_count: 3, confidence: calculateConfidence(3) })
  })

  it('leaves a template on another account alone: that booking never taught it', async () => {
    const table = templateTable([learned({ debit_account: '1630' })])

    expect(await unlearnCounterpartyTemplate(table.supabase, 'company-1', bankLine, reversedLines)).toBeNull()
    expect(table.updates).toHaveLength(0)
  })

  it('leaves a rule the person set to book on its own alone', async () => {
    const table = templateTable([learned({ mode: 'auto' })])

    expect(await unlearnCounterpartyTemplate(table.supabase, 'company-1', bankLine, reversedLines)).toBeNull()
    expect(table.updates).toHaveLength(0)
  })

  it('leaves a template already switched off alone', async () => {
    const table = templateTable([learned({ is_active: false })])

    expect(await unlearnCounterpartyTemplate(table.supabase, 'company-1', bankLine, reversedLines)).toBeNull()
    expect(table.updates).toHaveLength(0)
  })

  it('matches an income template on its credit leg', async () => {
    const customer = makeTransaction({ merchant_name: 'Kund AB', amount: 1000 })
    const template = makeCategorizationTemplate({
      counterparty_name: normalizeCounterpartyName('Kund AB'),
      debit_account: '1930',
      credit_account: '3001',
      occurrence_count: 2,
    })
    const table = templateTable([template])
    const lines = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 800 },
      { account_number: '2611', debit_amount: 0, credit_amount: 200 },
    ]

    expect(await unlearnCounterpartyTemplate(table.supabase, 'company-1', customer, lines)).toBe('decremented')
  })
})
