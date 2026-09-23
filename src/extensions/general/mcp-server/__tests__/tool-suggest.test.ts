import { describe, it, expect } from 'vitest'
import { suggestToolNames } from '../tool-suggest'

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
