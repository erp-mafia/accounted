import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  InboxPurchaseCategorySchema,
  readPurchaseCategoryOverride,
  resolveInboxPurchaseCategories,
  resolveInboxPurchaseCategoryChoices,
  templatePurchaseAccount,
} from '../inbox-purchase-category'

const mock = createQueuedMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient
const COMPANY = 'company-1'

beforeEach(() => mock.reset())

function template(overrides: Record<string, unknown> = {}) {
  return {
    counterparty_name: 'telia company',
    counterparty_aliases: [],
    debit_account: '6212',
    credit_account: '1930',
    line_pattern: null,
    occurrence_count: 12,
    corrections: 0,
    source: 'auto_learned',
    ...overrides,
  }
}

function reading(overrides: Record<string, unknown> = {}) {
  return {
    documentKind: 'supplier_invoice',
    supplier: { name: 'Telia Company AB' },
    invoice: { currency: 'SEK' },
    lineItems: [],
    totals: { total: 499 },
    ...overrides,
  }
}

describe('readPurchaseCategoryOverride', () => {
  it('reads a person\'s choice of a known code, and nothing else', () => {
    expect(readPurchaseCategoryOverride({ purchaseCategory: { code: 'expense.equipment.hardware', source: 'person', set_at: 'x' } })).toBe(
      'expense.equipment.hardware',
    )
    expect(readPurchaseCategoryOverride({ purchaseCategory: { code: 'expense.equipment.hardware', source: 'model' } })).toBeNull()
    expect(readPurchaseCategoryOverride({ purchaseCategory: { code: 'nope', source: 'person' } })).toBeNull()
    expect(readPurchaseCategoryOverride({ purchaseCategory: 'expense.equipment.hardware' })).toBeNull()
    expect(readPurchaseCategoryOverride(null)).toBeNull()
  })
})

describe('templatePurchaseAccount', () => {
  it('takes the cost side of a single-line purchase template', () => {
    expect(templatePurchaseAccount({ debit_account: '6212', credit_account: '1930', line_pattern: null })).toBe('6212')
  })

  it('has no purchase account for an income or transfer template', () => {
    expect(templatePurchaseAccount({ debit_account: '1930', credit_account: '3001', line_pattern: null })).toBeNull()
    expect(templatePurchaseAccount({ debit_account: '1930', credit_account: '1940', line_pattern: null })).toBeNull()
  })

  it('takes the largest cost line of a pattern, the reverse-charge basis pair set aside', () => {
    expect(
      templatePurchaseAccount({
        debit_account: '5420',
        credit_account: '1930',
        line_pattern: [
          { account: '5420', type: 'business', side: 'debit', ratio: 1 },
          { account: '4535', type: 'business', side: 'debit', ratio: 1 },
          { account: '4598', type: 'business', side: 'credit', ratio: 1 },
          { account: '2645', type: 'vat', side: 'debit', vat_rate: 0.25 },
          { account: '2614', type: 'vat', side: 'credit', vat_rate: 0.25 },
        ],
      }),
    ).toBe('5420')
    expect(
      templatePurchaseAccount({
        debit_account: '6110',
        credit_account: '1930',
        line_pattern: [
          { account: '6110', type: 'business', side: 'debit', ratio: 0.3 },
          { account: '5410', type: 'business', side: 'debit', ratio: 0.7 },
          { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
        ],
      }),
    ).toBe('5410')
  })

  it('refuses a pattern whose cost lines tie', () => {
    expect(
      templatePurchaseAccount({
        debit_account: '6110',
        credit_account: '1930',
        line_pattern: [
          { account: '6110', type: 'business', side: 'debit', ratio: 0.5 },
          { account: '5410', type: 'business', side: 'debit', ratio: 0.5 },
        ],
      }),
    ).toBeNull()
  })
})

describe('resolveInboxPurchaseCategories', () => {
  it('answers a person\'s choice without reading anything', async () => {
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading({ purchaseCategory: { code: 'expense.equipment.furniture', source: 'person', set_at: 'x' } }) },
    ])
    expect(out.get('a')).toEqual({ code: 'expense.equipment.furniture', source: 'person', level: 'Ditt val', version: 'pc-2026-10' })
    expect(mock.calls).toHaveLength(0)
  })

  it('answers null for an item without a reading', async () => {
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [{ id: 'a', extracted_data: null }])
    expect(out.get('a')).toBeNull()
    expect(mock.calls).toHaveLength(0)
  })

  it('reads the counterparty\'s history by its normalized name: Stark', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [{ id: 'a', extracted_data: reading() }])
    expect(out.get('a')).toEqual({ code: 'expense.telecom.mobile', source: 'counterparty', level: 'Stark', version: 'pc-2026-10' })
    expect(InboxPurchaseCategorySchema.parse(out.get('a'))).toEqual(out.get('a'))

    const byName = mock.findCalls('categorization_templates', 'in')
    expect(byName[0]).toEqual(['counterparty_name', ['telia company']])
    expect(mock.findCall('categorization_templates', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('finds a renamed template through its aliases, quoting each element', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [template({ counterparty_name: 'mobilen', counterparty_aliases: ['telia company'] })] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [{ id: 'a', extracted_data: reading() }])
    expect(out.get('a')?.code).toBe('expense.telecom.mobile')
    expect(mock.findCall('categorization_templates', 'overlaps')).toEqual([
      'counterparty_aliases',
      '{"telia company","telia company ab"}',
    ])
  })

  it('counts corrections against the history', async () => {
    mock.enqueue({ data: [template({ occurrence_count: 4, corrections: 2 })] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [{ id: 'a', extracted_data: reading() }])
    expect(out.get('a')).toMatchObject({ code: 'expense.telecom.mobile', level: 'Trolig' })
  })

  it('never treats a system default template as history', async () => {
    mock.enqueue({ data: [template({ source: 'sni_default' })] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [{ id: 'a', extracted_data: reading() }])
    expect(out.get('a')).toBeNull()
  })

  it('suggests the matched supplier\'s default account when the lines carry none', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: 'sup-1', default_expense_account: '6530' }] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading({ supplier: { name: 'Byrån AB' } }), matched_supplier_id: 'sup-1' },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.professional_services.accounting', source: 'account', level: 'Trolig' })
    expect(mock.findCall('suppliers', 'in')).toEqual(['id', ['sup-1']])
  })

  it('takes the lines\' own account suggestion over the supplier\'s default account when they agree on one', async () => {
    mock.enqueue({ data: [{ id: 'sup-1', default_expense_account: '5410', default_purchase_category: null }] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      {
        id: 'a',
        extracted_data: reading({
          supplier: { name: null },
          lineItems: [
            { description: 'Del 1', lineTotal: 100, accountSuggestion: '6530' },
            { description: 'Del 2', lineTotal: 50, accountSuggestion: '6530' },
          ],
        }),
        matched_supplier_id: 'sup-1',
      },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.professional_services.accounting', source: 'account' })
    // The supplier is read only for its instruction; no template is looked up without a name.
    expect(mock.findCall('categorization_templates', 'select')).toBeUndefined()
  })

  it('proposes the supplier\'s instruction as Ditt val over the learned history', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: 'sup-1', default_expense_account: '6212', default_purchase_category: 'expense.telecom.internet' }] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading(), matched_supplier_id: 'sup-1' },
    ])
    expect(out.get('a')).toEqual({ code: 'expense.telecom.internet', source: 'instruction', level: 'Ditt val', version: 'pc-2026-10' })
    expect(InboxPurchaseCategorySchema.parse(out.get('a'))).toEqual(out.get('a'))
    expect(mock.findCall('suppliers', 'select')?.[0]).toBe('id, default_expense_account, default_purchase_category')
    expect(mock.findCalls('suppliers', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('never lets the instruction override a person\'s choice on a single item, and reads nothing for it', async () => {
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      {
        id: 'a',
        extracted_data: reading({ purchaseCategory: { code: 'expense.equipment.hardware', source: 'person', set_at: 'x' } }),
        matched_supplier_id: 'sup-1',
      },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.equipment.hardware', source: 'person', level: 'Ditt val' })
    expect(mock.calls).toHaveLength(0)
  })

  it('applies the instruction to an item that has no reading yet, and ignores a code it does not know', async () => {
    mock.enqueue({
      data: [
        { id: 'sup-1', default_expense_account: null, default_purchase_category: 'expense.equipment.tools' },
        { id: 'sup-2', default_expense_account: null, default_purchase_category: 'gone.code' },
      ],
    })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: null, matched_supplier_id: 'sup-1' },
      { id: 'b', extracted_data: null, matched_supplier_id: 'sup-2' },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.equipment.tools', source: 'instruction', level: 'Ditt val' })
    expect(out.get('b')).toBeNull()
  })

  it('keeps the instruction when the history cannot be read', async () => {
    mock.enqueue({ data: null, error: { message: 'statement timeout' } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: 'sup-1', default_expense_account: null, default_purchase_category: 'expense.telecom.internet' }] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading(), matched_supplier_id: 'sup-1' },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.telecom.internet', source: 'instruction' })
  })

  it('falls back to the learned proposal when the supplier cannot be read', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading(), matched_supplier_id: 'sup-1' },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.telecom.mobile', source: 'counterparty' })
  })

  it('falls back to the reading alone when the history cannot be read', async () => {
    mock.enqueue({ data: null, error: { message: 'statement timeout' } })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading({ documentKind: 'receipt', merchantCategory: 'taxi', supplier: { name: 'Taxi Kurir' } }) },
    ])
    expect(out.get('a')).toMatchObject({ code: 'expense.travel.taxi', source: 'merchant_category' })
  })

  it('reads a whole page in one round of queries', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategories(supabase, COMPANY, [
      { id: 'a', extracted_data: reading() },
      { id: 'b', extracted_data: reading({ supplier: { name: 'Telia Company AB' } }) },
      { id: 'c', extracted_data: reading({ supplier: { name: 'Okänd' }, lineItems: [{ description: 'Kontorsstol', lineTotal: 1 }] }) },
    ])
    expect(out.get('a')?.code).toBe('expense.telecom.mobile')
    expect(out.get('b')?.code).toBe('expense.telecom.mobile')
    expect(out.get('c')).toMatchObject({ code: 'expense.equipment.furniture', source: 'lines' })
    expect(mock.calls.filter((c) => c.method === 'select')).toHaveLength(2)
  })
})

describe('resolveInboxPurchaseCategoryChoices', () => {
  it('reads the evidence under a person\'s choice and offers what the history alone says', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategoryChoices(supabase, COMPANY, {
      id: 'a',
      extracted_data: reading({ purchaseCategory: { code: 'expense.equipment.furniture', source: 'person', set_at: 'x' } }),
    })
    expect(out.proposal).toEqual({ code: 'expense.equipment.furniture', source: 'person', level: 'Ditt val', version: 'pc-2026-10' })
    expect(out.alternatives).toEqual([{ code: 'expense.telecom.mobile', source: 'counterparty' }])
    expect(mock.findCalls('categorization_templates', 'in')[0]).toEqual(['counterparty_name', ['telia company']])
  })

  it('offers the supplier\'s instruction under a choice on the item', async () => {
    mock.enqueue({ data: [template()] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: 'sup-1', default_expense_account: null, default_purchase_category: 'expense.telecom.internet' }] })
    const out = await resolveInboxPurchaseCategoryChoices(supabase, COMPANY, {
      id: 'a',
      extracted_data: reading({ purchaseCategory: { code: 'expense.equipment.furniture', source: 'person', set_at: 'x' } }),
      matched_supplier_id: 'sup-1',
    })
    expect(out.proposal).toMatchObject({ code: 'expense.equipment.furniture', source: 'person' })
    expect(out.alternatives).toEqual([
      { code: 'expense.telecom.internet', source: 'instruction' },
      { code: 'expense.telecom.mobile', source: 'counterparty' },
    ])
  })

  it('offers the categories of a shared booked account where the proposal stays null', async () => {
    mock.enqueue({ data: [template({ counterparty_name: 'clas ohlson', debit_account: '5410' })] })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategoryChoices(supabase, COMPANY, {
      id: 'a',
      extracted_data: reading({ supplier: { name: 'Clas Ohlson' } }),
    })
    expect(out.proposal).toBeNull()
    expect(out.alternatives.map((a) => a.code)).toEqual([
      'expense.equipment.hardware',
      'expense.equipment.furniture',
      'expense.equipment.tools',
    ])
  })

  it('falls back to the reading alone when the history cannot be read', async () => {
    mock.enqueue({ data: null, error: { message: 'statement timeout' } })
    mock.enqueue({ data: [] })
    const out = await resolveInboxPurchaseCategoryChoices(supabase, COMPANY, {
      id: 'a',
      extracted_data: reading({ documentKind: 'receipt', merchantCategory: 'restaurant', supplier: { name: 'Bistro Norr' } }),
    })
    expect(out.proposal).toBeNull()
    expect(out.alternatives.map((a) => a.source)).toEqual(['merchant_category', 'merchant_category', 'merchant_category'])
  })

  it('answers nothing for an item with nothing to go on, reading nothing', async () => {
    const out = await resolveInboxPurchaseCategoryChoices(supabase, COMPANY, { id: 'a', extracted_data: null })
    expect(out).toEqual({ proposal: null, alternatives: [] })
    expect(mock.calls).toHaveLength(0)
  })
})
