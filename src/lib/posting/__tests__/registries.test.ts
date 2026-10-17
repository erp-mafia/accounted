import { describe, expect, it } from 'vitest'
import { GROUP_ORDER } from '@/lib/bookkeeping/template-groups'
import {
  BUSINESS_EVENT_CATEGORIES,
  BUSINESS_EVENT_CATEGORY_PATTERN,
  categoryForTemplateGroup,
  categoryForTransactionCategory,
  isBusinessEventCategory,
} from '../categories'
import { BUSINESS_EVENT_KIND_PATTERN, BUSINESS_EVENT_KINDS, KIND_BY_SOURCE_TYPE, isBusinessEventKind, kindForSourceType } from '../kinds'
import { postingEventsMode } from '../mode'
import { mappingVersion } from '../mapping-version'
import type { TransactionCategory } from '@/types'

/** Every journal_entries.source_type the database accepts (journal_entries_source_type_check). */
const SOURCE_TYPES = [
  'manual', 'bank_transaction', 'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note',
  'salary_payment', 'opening_balance', 'year_end', 'storno', 'correction', 'import', 'system', 'inbox_item',
  'supplier_invoice_registered', 'supplier_invoice_paid', 'supplier_invoice_cash_payment',
  'supplier_credit_note', 'currency_revaluation', 'supplier_invoice_privately_paid', 'reminder_fee', 'accrual',
  'result_appropriation', 'rot_rut_payout', 'vat_settlement', 'stripe_payout', 'webshop_order', 'expense_claim',
  'expense_payout', 'rot_rut_reclaim', 'pos_daily_sales', 'rot_rut_reclassification',
]

const TRANSACTION_CATEGORIES: TransactionCategory[] = [
  'income_services', 'income_products', 'income_other', 'expense_equipment', 'expense_software',
  'expense_travel', 'expense_office', 'expense_marketing', 'expense_professional_services',
  'expense_education', 'expense_representation', 'expense_consumables', 'expense_vehicle',
  'expense_telecom', 'expense_bank_fees', 'expense_card_fees', 'expense_currency_exchange', 'expense_other',
  'private', 'uncategorized',
]

describe('business event kinds (a closed, add-only list)', () => {
  it('never renames or drops a kind: append new ones at the end', () => {
    expect(BUSINESS_EVENT_KINDS.slice(0, 29)).toEqual([
      'ledger.manual', 'ledger.storno', 'ledger.correction', 'ledger.opening_balance', 'ledger.history_import',
      'ledger.system', 'ledger.accrual', 'ledger.currency_revaluation', 'bank.categorized', 'sale.invoiced',
      'sale.payment_received', 'sale.credited', 'sale.reminder_fee', 'sale.webshop_order',
      'sale.pos_daily_takings', 'sale.payout_settled', 'purchase.registered', 'purchase.paid',
      'purchase.credited', 'purchase.document_booked', 'payroll.salary_paid', 'expense.claimed',
      'expense.paid_out', 'vat.settled', 'year_end.closing', 'year_end.result_appropriated',
      'se.rot_rut.payout_received', 'se.rot_rut.reclaimed', 'se.rot_rut.reclassified',
    ])
  })

  it('gives every source type the database accepts a kind, and every kind a source type', () => {
    for (const sourceType of SOURCE_TYPES) expect(kindForSourceType(sourceType), sourceType).not.toBeNull()
    expect(Object.keys(KIND_BY_SOURCE_TYPE).sort()).toEqual([...SOURCE_TYPES].sort())
    const reached = new Set(Object.values(KIND_BY_SOURCE_TYPE))
    expect(BUSINESS_EVENT_KINDS.filter((k) => !reached.has(k))).toEqual([])
  })

  it('keeps kinds unique and in the shape the database checks', () => {
    expect(new Set(BUSINESS_EVENT_KINDS).size).toBe(BUSINESS_EVENT_KINDS.length)
    for (const kind of BUSINESS_EVENT_KINDS) {
      expect(kind, kind).toMatch(BUSINESS_EVENT_KIND_PATTERN)
      expect(kind.length).toBeLessThanOrEqual(64)
    }
    expect(isBusinessEventKind('bank.categorized')).toBe(true)
    expect(isBusinessEventKind('bank')).toBe(false)
    expect(kindForSourceType('not_a_source_type')).toBeNull()
    expect(kindForSourceType('toString')).toBeNull()
    expect(kindForSourceType(null)).toBeNull()
  })
})

describe('business event categories (a closed, add-only list)', () => {
  it('never renames or drops a key: append new ones at the end', () => {
    expect(BUSINESS_EVENT_CATEGORIES.slice(0, 28).map((c) => c.key)).toEqual([
      'income.services', 'income.products', 'income.other', 'income.sales', 'expense.equipment',
      'expense.software', 'expense.travel', 'expense.office', 'expense.marketing',
      'expense.professional_services', 'expense.education', 'expense.representation', 'expense.consumables',
      'expense.vehicle', 'expense.telecom', 'expense.bank_fees', 'expense.card_fees',
      'expense.currency_exchange', 'expense.other', 'expense.premises', 'expense.goods', 'expense.insurance',
      'expense.personnel', 'finance.banking', 'finance.other', 'owner.transfer', 'se.tax.settlement',
      'se.closing.appropriations',
    ])
  })

  it('files every transaction category but uncategorized under exactly one key', () => {
    for (const category of TRANSACTION_CATEGORIES.filter((c) => c !== 'uncategorized')) {
      const owners = BUSINESS_EVENT_CATEGORIES.filter((c) => (c.transactionCategories as readonly string[]).includes(category))
      expect(owners, category).toHaveLength(1)
      expect(categoryForTransactionCategory(category)).toBe(owners[0]!.key)
    }
    expect(categoryForTransactionCategory('uncategorized')).toBeNull()
    expect(categoryForTransactionCategory(null)).toBeNull()
  })

  it('files every booking template family under exactly one key', () => {
    for (const group of GROUP_ORDER) {
      const owners = BUSINESS_EVENT_CATEGORIES.filter((c) => (c.templateGroups as readonly string[]).includes(group))
      expect(owners, group).toHaveLength(1)
      expect(categoryForTemplateGroup(group)).toBe(owners[0]!.key)
    }
  })

  it('keeps keys unique, in the database shape, and se. only for the Swedish rule sets', () => {
    const keys = BUSINESS_EVENT_CATEGORIES.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key, key).toMatch(BUSINESS_EVENT_CATEGORY_PATTERN)
      expect(key.length).toBeLessThanOrEqual(64)
    }
    expect(keys.filter((k) => k.startsWith('se.'))).toEqual(['se.tax.settlement', 'se.closing.appropriations'])
    expect(isBusinessEventCategory('expense.software')).toBe(true)
    expect(isBusinessEventCategory('expense_software')).toBe(false)
  })
})

describe('POSTING_EVENTS', () => {
  it('is off unless set to shadow or strict', () => {
    expect(postingEventsMode({})).toBe('off')
    expect(postingEventsMode({ POSTING_EVENTS: '' })).toBe('off')
    expect(postingEventsMode({ POSTING_EVENTS: 'off' })).toBe('off')
    expect(postingEventsMode({ POSTING_EVENTS: 'shadow' })).toBe('shadow')
    expect(postingEventsMode({ POSTING_EVENTS: ' Strict ' })).toBe('strict')
    expect(postingEventsMode({ POSTING_EVENTS: 'on' })).toBe('off')
    expect(postingEventsMode({ POSTING_EVENTS: 'true' })).toBe('off')
  })

  it('is read from the environment at every call', () => {
    const before = process.env.POSTING_EVENTS
    try {
      delete process.env.POSTING_EVENTS
      expect(postingEventsMode()).toBe('off')
      process.env.POSTING_EVENTS = 'shadow'
      expect(postingEventsMode()).toBe('shadow')
    } finally {
      if (before === undefined) delete process.env.POSTING_EVENTS
      else process.env.POSTING_EVENTS = before
    }
  })
})

describe('mapping_version', () => {
  it('names the rule source and the rubric version, else the build, else unversioned', () => {
    expect(mappingVersion('category', 'bank-proposals.1+a38016f12abc')).toBe('se.category-mapping@bank-proposals.1+a38016f12abc')
    expect(mappingVersion('bookingTemplate', 'r1')).toBe('se.booking-template@r1')
    expect(mappingVersion('counterpartyTemplate', 'r1')).toBe('counterparty-template@r1')
    expect(mappingVersion('mappingRule', 'r1')).toBe('mapping-rule@r1')
    expect(mappingVersion('mappingEngine', 'r1')).toBe('se.mapping-engine@r1')
    const before = { sha: process.env.VERCEL_GIT_COMMIT_SHA, build: process.env.NEXT_PUBLIC_BUILD_ID }
    try {
      process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890'
      expect(mappingVersion('category')).toBe('se.category-mapping@abcdef123456')
      delete process.env.VERCEL_GIT_COMMIT_SHA
      delete process.env.NEXT_PUBLIC_BUILD_ID
      expect(mappingVersion('category')).toBe('se.category-mapping@unversioned')
    } finally {
      if (before.sha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA
      else process.env.VERCEL_GIT_COMMIT_SHA = before.sha
      if (before.build === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID
      else process.env.NEXT_PUBLIC_BUILD_ID = before.build
    }
  })
})
