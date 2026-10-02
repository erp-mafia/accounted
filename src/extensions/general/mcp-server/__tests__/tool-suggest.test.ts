import { describe, it, expect } from 'vitest'
import { suggestToolNames } from '../tool-suggest'
import { tools } from '../server'

const catalog = [
  { name: 'gnubok_reverse_journal_entry', description: 'Stage a storno of a posted journal entry.' },
  { name: 'gnubok_query_journal', description: 'Read journal entries with lines.', annotations: { readOnlyHint: true } },
  { name: 'gnubok_list_accounts', description: 'Chart of accounts.', annotations: { readOnlyHint: true } },
  { name: 'gnubok_list_cash_accounts', description: 'Bank accounts and their ledger account.', annotations: { readOnlyHint: true }, keywords: ['bankkonto'] },
  { name: 'gnubok_create_invoice', description: 'Stage a customer invoice.' },
]

describe('suggestToolNames', () => {
  it('ranks a read tool first for a read-shaped guess', () => {
    expect(suggestToolNames('gnubok_get_journal_entry', catalog)[0].name).toBe('gnubok_query_journal')
  })

  it('matches plural and singular forms', () => {
    expect(suggestToolNames('gnubok_get_account', catalog).map((t) => t.name)).toContain('gnubok_list_accounts')
  })

  it('strips any namespace prefix, including a client-added mcp_ one', () => {
    expect(suggestToolNames('mcp_accounted_accounted_list_cash_accounts', catalog)[0].name).toBe('gnubok_list_cash_accounts')
  })

  it('suggests nothing for a guess made only of verbs', () => {
    expect(suggestToolNames('gnubok_get', catalog)).toEqual([])
  })

  it('suggests nothing when no subject word matches anything', () => {
    expect(suggestToolNames('gnubok_get_weather', catalog)).toEqual([])
  })

  it('caps the list', () => {
    expect(suggestToolNames('gnubok_list_accounts', catalog, 1)).toHaveLength(1)
  })
})

// Each catalog below is built so the candidates score the same; the order of
// the answer is then the tie-break alone, checked in both registry orders so
// registry order cannot pass the test by luck.
describe('suggestToolNames: equal scores', () => {
  const bothOrders = <T>(list: T[]) => [list, [...list].reverse()]
  const first = (guess: string, list: Parameters<typeof suggestToolNames>[1]) => suggestToolNames(guess, list)[0].name

  it('goes to the guess verb when the names are equally close: list_salary_runs for a list_ guess', () => {
    const payroll = [
      { name: 'gnubok_get_salary_run', description: 'One salary run.', annotations: { readOnlyHint: true } },
      { name: 'gnubok_list_salary_runs', description: 'Salary runs, oldest first.', annotations: { readOnlyHint: true } },
    ]
    for (const list of bothOrders(payroll)) {
      expect(first('gnubok_list_salary_run', list)).toBe('gnubok_list_salary_runs')
      expect(first('gnubok_get_salary_runs', list)).toBe('gnubok_get_salary_run')
      // A client-stacked namespace still leaves the verb first.
      expect(first('mcp__accounted__accounted_list_salary_run', list)).toBe('gnubok_list_salary_runs')
    }
  })

  it('goes to a read over a write for a read guess', () => {
    const skattekonto = [
      { name: 'gnubok_book_skattekonto_row', description: 'Stage booking one row.' },
      {
        name: 'gnubok_list_reconciliation_items',
        description: 'Rows behind one reconciliation.',
        annotations: { readOnlyHint: true },
        keywords: ['skattekonto rows'],
      },
    ]
    for (const list of bothOrders(skattekonto)) {
      expect(first('gnubok_get_skattekonto_rows', list)).toBe('gnubok_list_reconciliation_items')
    }
  })

  it('goes to the closer name before the verb: get_supplier keeps list_suppliers first', () => {
    const suppliers = [
      { name: 'gnubok_get_supplier_payment_batch', description: 'One payment batch.', annotations: { readOnlyHint: true } },
      { name: 'gnubok_list_suppliers', description: 'The supplier register.', annotations: { readOnlyHint: true } },
    ]
    for (const list of bothOrders(suppliers)) {
      expect(first('gnubok_get_supplier', list)).toBe('gnubok_list_suppliers')
    }
  })
})

// Prod telemetry 2026-09-23..28: guessed names the real catalog answered badly.
describe('suggestToolNames on the real catalog', () => {
  const names = (guess: string) => suggestToolNames(guess, tools).map((t) => t.name)

  it('answers a list_ guess with the list tool', () => {
    expect(names('gnubok_list_salary_run')[0]).toBe('gnubok_list_salary_runs')
  })

  it('suggests gnubok_get_party for gnubok_get_customer', () => {
    expect(names('gnubok_get_customer')).toContain('gnubok_get_party')
  })

  it.each([
    'gnubok_waive_document_requirement',
    'gnubok_waive_missing_document',
    'gnubok_waive_underlag',
    'gnubok_mark_document_not_required',
    'gnubok_set_no_document_needed',
    'gnubok_mark_verifikat_waived',
  ])('puts gnubok_mark_no_document_required first for %s', (guess) => {
    expect(names(guess)[0]).toBe('gnubok_mark_no_document_required')
  })

  it('answers gnubok_list_skattekonto_rows with the read, not the two booking writes', () => {
    expect(names('gnubok_list_skattekonto_rows')[0]).toBe('gnubok_list_reconciliation_items')
  })

  it('answers gnubok_get_recent_rejections with gnubok_list_pending_operations', () => {
    expect(names('gnubok_get_recent_rejections')[0]).toBe('gnubok_list_pending_operations')
  })
})
