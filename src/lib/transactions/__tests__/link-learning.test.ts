/**
 * A bank row linked onto one existing verifikat teaches its bank text
 * (crm#1746): at once when a person or an agent chose the pair, after a
 * repetition when the matcher did, and never from a clearing, an invoice's
 * verifikat, a samlingsverifikat or a text that names no one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { learnFromBankLink, learnFromBankLinks } from '../link-learning'

const COMPANY = 'company-1'
const PENSION_TEXT = 'ACME PENSION'

type Row = Record<string, unknown>
type Line = [account: string, debit: number, credit: number]

function bankRow(id: string, journalEntryId: string | null, overrides: Row = {}): Row {
  return {
    id,
    company_id: COMPANY,
    date: '2026-11-03',
    amount: -10000,
    currency: 'SEK',
    merchant_name: null,
    original_description: PENSION_TEXT,
    description: PENSION_TEXT,
    counterparty_account: null,
    cash_account_id: null,
    journal_entry_id: journalEntryId,
    reconciliation_method: journalEntryId ? 'manual' : null,
    invoice_id: null,
    supplier_invoice_id: null,
    transaction_voucher_links: [],
    ...overrides,
  }
}

function verifikat(id: string, lines: Line[], overrides: Row = {}) {
  return {
    entry: { id, company_id: COMPANY, status: 'posted', source_type: 'manual', ...overrides },
    lines: lines.map(([account_number, debit_amount, credit_amount], i) => ({
      id: `${id}-l${i}`,
      journal_entry_id: id,
      account_number,
      debit_amount,
      credit_amount,
      currency: 'SEK',
      amount_in_currency: null,
    })),
  }
}

/** Tjänstepension with särskild löneskatt: the multi-line shape the agent asked for. */
const PENSION_LINES: Line[] = [
  ['7412', 10000, 0],
  ['7533', 2426, 0],
  ['2514', 0, 2426],
  ['1930', 0, 10000],
]

const PENSION_PATTERN = [
  { account: '7412', type: 'business', side: 'debit', ratio: 0.6734 },
  { account: '7533', type: 'business', side: 'debit', ratio: 0.1633 },
  { account: '2514', type: 'business', side: 'credit', ratio: 0.1633 },
]

let writes: { table: string; method: string; row: unknown }[]

function world(input: {
  rows: Row[]
  entries: ReturnType<typeof verifikat>[]
  templates?: Row[]
  junction?: Row[]
  supplierInvoicePayments?: Row[]
}) {
  return createRowsMockSupabase(
    {
      transactions: input.rows,
      journal_entries: input.entries.map((v) => v.entry),
      journal_entry_lines: input.entries.flatMap((v) => v.lines),
      transaction_voucher_links: input.junction ?? [],
      categorization_templates: input.templates ?? [],
      invoices: [],
      invoice_payments: [],
      supplier_invoices: [],
      supplier_invoice_payments: input.supplierInvoicePayments ?? [],
    },
    writes,
  ).supabase
}

const templateWrites = () => writes.filter((w) => w.table === 'categorization_templates')

beforeEach(() => {
  writes = []
})

describe('explicit links teach at once', () => {
  it('learns the bank text with the multi-line pattern of the verifikat (pension plus löneskatt)', async () => {
    const supabase = world({ rows: [bankRow('tx-1', 'je-1')], entries: [verifikat('je-1', PENSION_LINES)] })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'learned' })
    expect(templateWrites()).toHaveLength(1)
    expect(templateWrites()[0]).toMatchObject({
      method: 'insert',
      row: {
        company_id: COMPANY,
        counterparty_name: 'acme pension',
        counterparty_aliases: ['acme pension'],
        debit_account: '7412',
        credit_account: '1930',
        line_pattern: PENSION_PATTERN,
        occurrence_count: 1,
        source: 'user_approved',
        last_seen_date: '2026-11-03',
      },
    })
  })

  it('learns a simple cost with its moms on the legacy fields', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { amount: -1250, original_description: 'Kontorsbolaget', description: 'Kontorsbolaget' })],
      entries: [verifikat('je-1', [['6110', 1000, 0], ['2641', 250, 0], ['1930', 0, 1250]], { source_type: 'import' })],
    })

    await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(templateWrites()[0].row).toMatchObject({
      counterparty_name: 'kontorsbolaget',
      debit_account: '6110',
      credit_account: '1930',
      vat_account: '2641',
      vat_treatment: 'standard_25',
      line_pattern: null,
    })
  })

  it('learns a card row with the bank placeholder on its bank leg', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { amount: -500, original_description: 'Bokhandeln', description: 'Bokhandeln' })],
      entries: [verifikat('je-1', [['6970', 500, 0], ['2890', 0, 500]])],
    })

    await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(templateWrites()[0].row).toMatchObject({ debit_account: '6970', credit_account: '1930' })
  })
})

describe('automatic links teach only once the same text repeats', () => {
  it('teaches nothing from the first link of a bank text', async () => {
    const supabase = world({ rows: [bankRow('tx-1', 'je-1')], entries: [verifikat('je-1', PENSION_LINES, { source_type: 'import' })] })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'awaiting_repetition' })
    expect(templateWrites()).toEqual([])
  })

  it('teaches on the second link of the same text onto the same accounts, both links counted', async () => {
    const supabase = world({
      rows: [
        bankRow('tx-oct', 'je-oct', { date: '2026-10-03', reconciliation_method: 'auto_exact' }),
        bankRow('tx-nov', 'je-nov', { date: '2026-11-03', reconciliation_method: 'auto_exact' }),
      ],
      entries: [
        verifikat('je-oct', PENSION_LINES, { source_type: 'import' }),
        verifikat('je-nov', PENSION_LINES, { source_type: 'import' }),
      ],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-nov', journalEntryId: 'je-nov' }, 'automatic')

    expect(result).toEqual({ outcome: 'learned' })
    expect(templateWrites()).toHaveLength(1)
    expect(templateWrites()[0]).toMatchObject({
      method: 'insert',
      row: { counterparty_name: 'acme pension', line_pattern: PENSION_PATTERN, occurrence_count: 2, source: 'auto_learned' },
    })
  })

  it('counts the rows of one run for each other in date order: the first waits, the second teaches', async () => {
    const supabase = world({
      rows: [
        bankRow('tx-oct', 'je-oct', { date: '2026-10-03', reconciliation_method: 'auto_exact' }),
        bankRow('tx-nov', 'je-nov', { date: '2026-11-03', reconciliation_method: 'auto_exact' }),
      ],
      entries: [
        verifikat('je-oct', PENSION_LINES, { source_type: 'import' }),
        verifikat('je-nov', PENSION_LINES, { source_type: 'import' }),
      ],
    })

    const results = await learnFromBankLinks(
      supabase as never,
      COMPANY,
      [
        { transactionId: 'tx-nov', journalEntryId: 'je-nov' },
        { transactionId: 'tx-oct', journalEntryId: 'je-oct' },
      ],
      'automatic',
    )

    expect(results.get('tx-oct')).toEqual({ outcome: 'awaiting_repetition' })
    expect(results.get('tx-nov')).toEqual({ outcome: 'learned' })
    expect(templateWrites()).toHaveLength(1)
  })

  it('does not count an earlier link onto other accounts', async () => {
    const supabase = world({
      rows: [
        bankRow('tx-oct', 'je-oct', { date: '2026-10-03', reconciliation_method: 'auto_exact' }),
        bankRow('tx-nov', 'je-nov', { date: '2026-11-03', reconciliation_method: 'auto_exact' }),
      ],
      entries: [
        verifikat('je-oct', [['7410', 10000, 0], ['1930', 0, 10000]], { source_type: 'import' }),
        verifikat('je-nov', PENSION_LINES, { source_type: 'import' }),
      ],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-nov', journalEntryId: 'je-nov' }, 'automatic')

    expect(result).toEqual({ outcome: 'awaiting_repetition' })
    expect(templateWrites()).toEqual([])
  })

  it('counts on a template that already holds the shape, without touching its pattern', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact' })],
      entries: [verifikat('je-1', PENSION_LINES, { source_type: 'import' })],
      templates: [{
        id: 'tpl-1', company_id: COMPANY, counterparty_name: 'acme pension', counterparty_aliases: [], is_active: true,
        debit_account: '7412', credit_account: '1930', vat_account: null, vat_treatment: null,
        line_pattern: PENSION_PATTERN, occurrence_count: 3, source: 'user_approved', corrections: 0,
      }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'reapproved' })
    expect(templateWrites()).toHaveLength(1)
    const update = templateWrites()[0]
    expect(update.method).toBe('update')
    expect(update.row).toMatchObject({ occurrence_count: 4, source: 'user_approved' })
    expect(update.row).not.toHaveProperty('line_pattern')
    expect(update.row).not.toHaveProperty('debit_account')
  })

  it('never changes a template that books the text on other accounts', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact' })],
      entries: [verifikat('je-1', PENSION_LINES, { source_type: 'import' })],
      templates: [{
        id: 'tpl-1', company_id: COMPANY, counterparty_name: 'acme pension', counterparty_aliases: [], is_active: true,
        debit_account: '7410', credit_account: '1930', vat_account: null, vat_treatment: null,
        line_pattern: null, occurrence_count: 3, source: 'user_approved', corrections: 0,
      }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'conflicts_template' })
    expect(templateWrites()).toEqual([])
  })

  it('never reads a template with the same accounts but another pair as a correction', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact' })],
      entries: [verifikat('je-1', PENSION_LINES, { source_type: 'import' })],
      templates: [{
        id: 'tpl-1', company_id: COMPANY, counterparty_name: 'acme pension', counterparty_aliases: [], is_active: true,
        debit_account: '7533', credit_account: '1930', vat_account: null, vat_treatment: null,
        line_pattern: PENSION_PATTERN, occurrence_count: 3, source: 'user_approved', corrections: 0,
      }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'conflicts_template' })
    expect(templateWrites()).toEqual([])
  })

  it('never changes a template that books the same accounts with other moms', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact', amount: -250 })],
      entries: [verifikat('je-1', [['5420', 250, 0], ['1930', 0, 250]], { source_type: 'import' })],
      templates: [{
        id: 'tpl-1', company_id: COMPANY, counterparty_name: 'acme pension', counterparty_aliases: [], is_active: true,
        debit_account: '5420', credit_account: '1930', vat_account: '2645', vat_treatment: 'reverse_charge',
        line_pattern: null, occurrence_count: 3, source: 'user_approved', corrections: 0,
      }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'conflicts_template' })
    expect(templateWrites()).toEqual([])
  })
})

describe('a verifikat with moms of no one rate', () => {
  /** A storage rental: part of the invoice at 25 %, part without moms, 125 kr of moms on 725 kr. */
  const MIXED_MOMS: Line[] = [['5010', 600, 0], ['2641', 125, 0], ['1930', 0, 725]]
  const storageRow = (id: string, je: string, overrides: Row = {}) =>
    bankRow(id, je, { amount: -725, original_description: 'FORRADSHYRA AB', description: 'FORRADSHYRA AB', ...overrides })
  const heldWithoutMoms = {
    id: 'tpl-1', company_id: COMPANY, counterparty_name: 'forradshyra', counterparty_aliases: ['forradshyra ab'], is_active: true,
    debit_account: '5010', credit_account: '1930', vat_account: null, vat_treatment: null,
    line_pattern: null, occurrence_count: 7, source: 'user_approved', corrections: 0,
  }

  it('the matcher\'s link never counts it as one more approval of a template without moms', async () => {
    const supabase = world({
      rows: [storageRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact' })],
      entries: [verifikat('je-1', MIXED_MOMS, { source_type: 'import' })],
      templates: [heldWithoutMoms],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'conflicts_template' })
    expect(templateWrites()).toEqual([])
  })

  it('a person\'s link corrects a template without moms to unknown moms', async () => {
    const supabase = world({
      rows: [storageRow('tx-1', 'je-1')],
      entries: [verifikat('je-1', MIXED_MOMS, { source_type: 'import' })],
      templates: [heldWithoutMoms],
    })

    await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(templateWrites()).toHaveLength(1)
    expect(templateWrites()[0]).toMatchObject({
      method: 'update',
      row: { vat_treatment: 'unknown', vat_account: '2641', occurrence_count: 1, corrections: 1 },
    })
  })

  it('the matcher counts it on a template whose moms is unknown', async () => {
    const supabase = world({
      rows: [storageRow('tx-1', 'je-1', { reconciliation_method: 'auto_exact' })],
      entries: [verifikat('je-1', MIXED_MOMS, { source_type: 'import' })],
      templates: [{ ...heldWithoutMoms, vat_account: '2641', vat_treatment: 'unknown', occurrence_count: 2 }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'automatic')

    expect(result).toEqual({ outcome: 'reapproved' })
    expect(templateWrites()[0].row).toMatchObject({ occurrence_count: 3 })
    expect(templateWrites()[0].row).not.toHaveProperty('vat_treatment')
  })

  it('does not count an earlier link with other moms on the same accounts as the repetition', async () => {
    const supabase = world({
      rows: [
        storageRow('tx-oct', 'je-oct', { date: '2026-10-03', reconciliation_method: 'auto_exact' }),
        storageRow('tx-nov', 'je-nov', { date: '2026-11-03', reconciliation_method: 'auto_exact' }),
      ],
      entries: [
        verifikat('je-oct', [['5010', 580, 0], ['2641', 145, 0], ['1930', 0, 725]], { source_type: 'import' }),
        verifikat('je-nov', MIXED_MOMS, { source_type: 'import' }),
      ],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-nov', journalEntryId: 'je-nov' }, 'automatic')

    expect(result).toEqual({ outcome: 'awaiting_repetition' })
    expect(templateWrites()).toEqual([])
  })
})

describe('never taught, whoever linked', () => {
  it.each<[string, Line[]]>([
    ['a payables clearing (2440 against the bank)', [['2440', 10000, 0], ['1930', 0, 10000]]],
    ['a receivables clearing (the bank against 1510)', [['1930', 10000, 0], ['1510', 0, 10000]]],
    ['a clearing with a fee beside it', [['2440', 9990, 0], ['6570', 10, 0], ['1930', 0, 10000]]],
  ])('%s', async (_label, lines) => {
    const amount = lines.find(([account]) => account === '1930')![1] > 0 ? 10000 : -10000
    const supabase = world({ rows: [bankRow('tx-1', 'je-1', { amount })], entries: [verifikat('je-1', lines)] })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'clearing_account' })
    expect(templateWrites()).toEqual([])
  })

  it('a samlingsverifikat: a verifikat another row holds too', async () => {
    const supabase = world({
      rows: [
        bankRow('tx-1', 'je-1', { amount: -5000 }),
        bankRow('tx-2', 'je-1', { amount: -5000 }),
      ],
      entries: [verifikat('je-1', PENSION_LINES)],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'samlingsverifikat' })
    expect(templateWrites()).toEqual([])
  })

  it('a row anchored to more than this verifikat (a residual booking, a split)', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', {
        transaction_voucher_links: [{ journal_entry_id: 'je-residual', role: 'other' }],
      })],
      entries: [verifikat('je-1', PENSION_LINES)],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'several_verifikat' })
  })

  it.each(['INTERNET BET 4', 'Lön'])('a bank text that names no counterpart (%s)', async (text) => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { original_description: text, description: text })],
      entries: [verifikat('je-1', PENSION_LINES)],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'no_counterparty' })
    expect(templateWrites()).toEqual([])
  })

  it('a verifikat a supplier invoice payment points at (kontantmetoden books the cost on it)', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1')],
      entries: [verifikat('je-1', PENSION_LINES)],
      supplierInvoicePayments: [{ id: 'sip-1', journal_entry_id: 'je-1' }],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'invoice_settlement' })
  })

  it('a row that settles a supplier invoice', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { supplier_invoice_id: 'si-1' })],
      entries: [verifikat('je-1', PENSION_LINES)],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'invoice_settlement' })
  })

  it('a verifikat a salary run made', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1')],
      entries: [verifikat('je-1', PENSION_LINES, { source_type: 'salary_payment' })],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'entry_not_learnable' })
  })

  it('a verifikat whose bank leg is more than the row', async () => {
    const supabase = world({
      rows: [bankRow('tx-1', 'je-1', { amount: -4000 })],
      entries: [verifikat('je-1', PENSION_LINES)],
    })

    const result = await learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit')

    expect(result).toEqual({ outcome: 'skipped', reason: 'bank_leg_mismatch' })
  })
})

describe('a failure to learn', () => {
  it('is answered, never thrown', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: null, error: { message: 'statement timeout' } },
    })

    await expect(
      learnFromBankLink(supabase as never, COMPANY, { transactionId: 'tx-1', journalEntryId: 'je-1' }, 'explicit'),
    ).resolves.toEqual({ outcome: 'failed' })
  })
})
