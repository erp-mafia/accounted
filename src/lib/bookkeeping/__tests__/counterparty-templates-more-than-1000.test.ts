/**
 * Product issue #58 (1000-row cap): one company holds more than 1,000 active
 * categorization templates (1,527 in production). An unpaged read answered
 * an arbitrary 1,000, so a rule past the cut never matched a bank row, and
 * the SIE learner, not seeing it, inserted a duplicate into the UNIQUE
 * conflict instead of updating it.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createPagedMockSupabase,
  makeCategorizationTemplate,
  makeSIEVoucher,
  makeTransaction,
  manyRows,
} from '@/tests/helpers'
import {
  findCounterpartyTemplatesBatch,
  normalizeCounterpartyName,
  populateTemplatesFromSieVouchers,
} from '../counterparty-templates'

const COMPANY_ID = 'company-1'

const TELIA_TEXT = 'Telia Sverige AB'

/** 1,200 active templates, the company's Telia rule at row 1,100. */
function templatesWithTeliaPastTheCut() {
  const telia = makeCategorizationTemplate({ counterparty_name: normalizeCounterpartyName(TELIA_TEXT) })
  const rows = manyRows(1200, (i) =>
    i === 1100
      ? telia
      : makeCategorizationTemplate({ counterparty_name: `leverantor nummer ${i}`, counterparty_aliases: [] }),
  )
  return { telia, rows }
}

describe('categorization templates past the 1,000-row page', () => {
  it('matches a bank row against a rule that sits past the first 1,000 templates', async () => {
    const { telia, rows } = templatesWithTeliaPastTheCut()
    const { supabase, findCalls } = createPagedMockSupabase({ categorization_templates: rows })
    const tx = makeTransaction({ merchant_name: TELIA_TEXT, amount: -500 })

    const matches = await findCounterpartyTemplatesBatch(supabase as unknown as SupabaseClient, COMPANY_ID, [tx])

    expect(matches.get(tx.id)?.template.id).toBe(telia.id)
    // Two pages, each ordered by the unique id.
    expect(findCalls('categorization_templates', 'order')).toEqual([['id'], ['id']])
  })

  it('the SIE learner updates a rule past the first 1,000 instead of inserting a duplicate', async () => {
    const { telia, rows } = templatesWithTeliaPastTheCut()
    const { supabase, findCalls } = createPagedMockSupabase({ categorization_templates: rows })
    const lines = [{ account: '1930', amount: -1000 }, { account: '6212', amount: 1000 }]
    const vouchers = [1, 2, 3].map((number) => makeSIEVoucher({ description: TELIA_TEXT, number, lines }))

    const written = await populateTemplatesFromSieVouchers(supabase as unknown as SupabaseClient, COMPANY_ID, vouchers)

    expect(written).toBe(1)
    expect(findCalls('categorization_templates', 'insert')).toEqual([])
    expect(findCalls('categorization_templates', 'eq')).toContainEqual(['id', telia.id])
  })
})
