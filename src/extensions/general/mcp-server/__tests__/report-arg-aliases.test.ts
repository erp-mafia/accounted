/**
 * Read-only report tools accept the parameter synonyms agents actually send
 * (prod telemetry: fiscal_period_id, date_from/date_to, start_date/end_date,
 * as_of_date, account_number, metric), mapped onto the tool's own names.
 * tools/list stays strict: no alias ever appears in a published schema.
 *
 * A mapping must never turn a loud rejection into a silent wrong answer, so
 * the aliases whose target would misread a value carry a value guard: an
 * unreadable value is left unmapped and the unknown-parameter guard rejects
 * it (the dispatcher side is in unknown-args-rejected.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  REPORT_ARG_ALIASES,
  describeAliasConflicts,
  describeArgHint,
  normalizeReportArgAliases,
  suggestArgKey,
} from '../report-arg-aliases'
import { listArgKeys, listRequiredArgKeys } from '../arg-guard'
import { parseRecordRef } from '../arkiv-tools'
import { tools } from '../server'

describe('normalizeReportArgAliases', () => {
  it('renames a known alias to the canonical parameter', () => {
    const { args, applied, conflicts } = normalizeReportArgAliases('gnubok_get_income_statement', {
      fiscal_period_id: 'fp-1',
      date_from: '2026-01-01',
    })
    expect(args).toEqual({ period_id: 'fp-1', from_date: '2026-01-01' })
    expect(applied.map((a) => a.alias).sort()).toEqual(['date_from', 'fiscal_period_id'])
    expect(conflicts).toEqual([])
  })

  it('wraps a scalar metric into the metrics array', () => {
    const { args } = normalizeReportArgAliases('gnubok_get_kpi_report', { metric: 'cash_position' })
    expect(args).toEqual({ metrics: ['cash_position'] })
  })

  it('maps the query_journal free-text synonyms to text', () => {
    const { args } = normalizeReportArgAliases('gnubok_query_journal', { query: 'hyra', start_date: '2026-01-01' })
    expect(args).toEqual({ text: 'hyra', date_from: '2026-01-01' })
  })

  it('refuses an alias that collides with its canonical key instead of picking a side', () => {
    const { args, conflicts } = normalizeReportArgAliases('gnubok_get_kpi_report', {
      metric: 'cash_position',
      metrics: ['net_result'],
    })
    expect(conflicts).toEqual([{ alias: 'metric', readsAs: ['metrics'], overlaps: 'metrics' }])
    expect(args.metrics).toEqual(['net_result'])
  })

  it('refuses two aliases that land on the same canonical key, naming the other alias', () => {
    const { conflicts } = normalizeReportArgAliases('gnubok_get_balance_sheet', {
      to_date: '2026-06-30',
      end_date: '2026-07-31',
    })
    expect(conflicts).toEqual([{ alias: 'end_date', readsAs: ['as_of_date'], overlaps: 'to_date' }])
  })

  it('leaves tools without an alias table untouched', () => {
    const input = { fiscal_period_id: 'fp-1' }
    const { args, applied } = normalizeReportArgAliases('gnubok_close_period', input)
    expect(args).toBe(input)
    expect(applied).toEqual([])
  })

  it('only targets read-only tools, and every mapping lands on a published parameter', () => {
    for (const [toolName, table] of Object.entries(REPORT_ARG_ALIASES)) {
      const tool = tools.find((t) => t.name === toolName)
      expect(tool, toolName).toBeDefined()
      expect(tool!.annotations?.readOnlyHint, toolName).toBe(true)
      const published = Object.keys((tool!.inputSchema as { properties: Record<string, unknown> }).properties)
      for (const [alias, rule] of Object.entries(table)) {
        expect(published, `${toolName}: alias ${alias} must not be published`).not.toContain(alias)
        for (const target of rule.to) {
          expect(published, `${toolName}: ${alias} -> ${target}`).toContain(target)
        }
      }
    }
  })
})

describe('value guards: an alias value the target would misread stays unmapped', () => {
  describe('gnubok_get_general_ledger account_number (fanned out to both string bounds)', () => {
    it('maps an exact four-digit account to both bounds', () => {
      for (const value of ['1930', ' 1930 ', 1930]) {
        const { args } = normalizeReportArgAliases('gnubok_get_general_ledger', { account_number: value })
        expect(args, JSON.stringify(value)).toEqual({ account_from: '1930', account_to: '1930' })
      }
    })

    it('leaves a partial or labelled account unmapped, so the call is rejected rather than empty', () => {
      for (const value of ['19', '1930 Företagskonto', '19300', 193, 1930.5, null, ['1930']]) {
        const input = { account_number: value }
        const { args, applied, conflicts } = normalizeReportArgAliases('gnubok_get_general_ledger', input)
        expect(args, JSON.stringify(value)).toEqual(input)
        expect(applied).toEqual([])
        expect(conflicts).toEqual([])
      }
    })
  })

  describe('gnubok_query_journal account_number / account (read by the accounts parser)', () => {
    it('passes the value through unchanged, so a comma-separated list stays a list', () => {
      for (const alias of ['account_number', 'account']) {
        for (const value of ['1930,1940', ['1930', '1940'], 1930]) {
          const { args } = normalizeReportArgAliases('gnubok_query_journal', { [alias]: value })
          expect(args, `${alias}=${JSON.stringify(value)}`).toEqual({ accounts: value })
        }
      }
    })
  })

  describe('gnubok_query_journal voucher_number', () => {
    const map = (args: Record<string, unknown>) => normalizeReportArgAliases('gnubok_query_journal', args)

    it('reads an integer or a digit string as one voucher number', () => {
      expect(map({ voucher_number: 12 }).args).toEqual({ voucher_number_from: 12, voucher_number_to: 12 })
      expect(map({ voucher_number: '12' }).args).toEqual({ voucher_number_from: 12, voucher_number_to: 12 })
    })

    it('reads a series and number as the series plus that voucher', () => {
      for (const value of ['A12', 'A 12', 'a-12']) {
        expect(map({ voucher_number: value }).args, value).toEqual({
          voucher_series: 'A',
          voucher_number_from: 12,
          voucher_number_to: 12,
        })
      }
    })

    it('keeps an explicit voucher_series next to a bare number', () => {
      const { args, conflicts } = map({ voucher_number: 12, voucher_series: 'B' })
      expect(conflicts).toEqual([])
      expect(args).toEqual({ voucher_series: 'B', voucher_number_from: 12, voucher_number_to: 12 })
    })

    it('refuses a series reference next to an explicit voucher_series', () => {
      const { conflicts } = map({ voucher_number: 'A12', voucher_series: 'B' })
      expect(conflicts).toEqual([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_series', 'voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_series',
        },
      ])
    })

    it('refuses a voucher number next to either range bound', () => {
      const { conflicts } = map({ voucher_number: 12, voucher_number_to: 20 })
      expect(conflicts).toEqual([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_number_to',
        },
      ])
    })

    it('leaves anything else unmapped, so the call is rejected rather than run unfiltered', () => {
      for (const value of ['A12B', 'twelve', '', '12-14', 12.5, true, null, { n: 12 }, [12]]) {
        const input = { voucher_number: value }
        const { args, applied, conflicts } = map(input)
        expect(args, JSON.stringify(value)).toEqual(input)
        expect(applied).toEqual([])
        expect(conflicts).toEqual([])
      }
    })
  })

  it('writes only keys each rule declares', () => {
    const samples: Record<string, unknown[]> = {
      account_number: ['1930', 1930],
      voucher_number: [12, '12', 'A12'],
      metric: ['cash_position', ['cash_position']],
    }
    for (const [toolName, table] of Object.entries(REPORT_ARG_ALIASES)) {
      for (const [alias, rule] of Object.entries(table)) {
        for (const value of samples[alias] ?? ['x']) {
          const { applied } = normalizeReportArgAliases(toolName, { [alias]: value })
          for (const entry of applied) {
            for (const key of entry.to) expect(rule.to, `${toolName}.${alias} wrote ${key}`).toContain(key)
          }
        }
      }
    }
  })
})

describe('Object.prototype names are never read as aliases or synonyms', () => {
  it('ignores a tool name or argument named like an Object.prototype member', () => {
    for (const toolName of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const input = { fiscal_period_id: 'fp-1' }
      const { args, applied } = normalizeReportArgAliases(toolName, input)
      expect(args, toolName).toBe(input)
      expect(applied).toEqual([])
    }
    const input = JSON.parse('{"constructor": "x", "__proto__": "y", "toString": "z"}') as Record<string, unknown>
    const { args, applied } = normalizeReportArgAliases('gnubok_query_journal', input)
    expect(args).toEqual(input)
    expect(applied).toEqual([])
  })

  it('suggests nothing for them instead of throwing', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(suggestArgKey(key, ['period_id', 'constructor', 'toString']), key).toBeNull()
    }
  })
})

describe('describeAliasConflicts', () => {
  it('says what each alias is read as and what it overlaps, without claiming synonymy', () => {
    const text = describeAliasConflicts([
      {
        alias: 'voucher_number',
        readsAs: ['voucher_number_from', 'voucher_number_to'],
        overlaps: 'voucher_number_to',
      },
      { alias: 'fiscal_period_id', readsAs: ['period_id'], overlaps: 'period_id' },
    ])
    expect(text).toBe(
      '"voucher_number" (read as "voucher_number_from" and "voucher_number_to") overlaps "voucher_number_to"; ' +
        '"fiscal_period_id" (read as "period_id") overlaps "period_id". Send only one of each pair.',
    )
  })

  it('joins three targets as "a", "b" and "c"', () => {
    expect(
      describeAliasConflicts([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_series', 'voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_series',
        },
      ]),
    ).toContain('(read as "voucher_series", "voucher_number_from" and "voucher_number_to")')
  })
})

describe('suggestArgKey', () => {
  it('names the parameter an unknown synonym most likely meant', () => {
    expect(suggestArgKey('fiscal_period_id', ['period_id', 'account'])).toBe('period_id')
    expect(suggestArgKey('date_from', ['from_date', 'to_date'])).toBe('from_date')
    expect(suggestArgKey('search', ['query', 'limit'])).toBe('query')
    expect(suggestArgKey('voucher_number', ['voucher_number_from', 'voucher_number_to'])).toBe(
      'voucher_number_from',
    )
    expect(suggestArgKey('account_number', ['period_id', 'account_from', 'account_to'])).toBe('account_from')
  })

  it('returns null when nothing close is valid', () => {
    expect(suggestArgKey('fiscal_period_id', ['invoice_id'])).toBeNull()
    expect(suggestArgKey('fromdate', ['from_date'])).toBeNull()
  })
})

/** The hint the dispatcher would give for one unknown key on a real tool. */
function hintOn(toolName: string, unknownKey: string, args: Record<string, unknown> = { [unknownKey]: 'x' }) {
  const tool = tools.find((t) => t.name === toolName)
  if (!tool) throw new Error(`no tool ${toolName}`)
  const schema = tool.inputSchema as Record<string, unknown>
  const validKeys = listArgKeys(schema)
  expect(validKeys, `${toolName} must not already accept ${unknownKey}`).not.toContain(unknownKey)
  return suggestArgKey(unknownKey, validKeys, { required: listRequiredArgKeys(schema), args })
}

// Prod telemetry 2026-09-23..28: calls rejected with no hint at all. Each
// synonym is checked against the real schemas, both ways: it names the target
// on a tool that has it, and nothing on one that does not.
describe('suggestArgKey: the synonyms agents sent, against real schemas', () => {
  it.each([
    ['name', 'gnubok_load_skill', 'slug', 'gnubok_list_skills'],
    ['skill', 'gnubok_load_skill', 'slug', 'gnubok_list_skills'],
    ['skill_name', 'gnubok_load_skill', 'slug', 'gnubok_list_skills'],
    ['document_id', 'gnubok_ask_document', 'record_ref', 'gnubok_list_skills'],
    ['record_id', 'gnubok_get_record', 'record_ref', 'gnubok_list_skills'],
    ['record_type', 'gnubok_list_records', 'type', 'gnubok_list_skills'],
    ['record_type', 'gnubok_get_record', 'record_ref', 'gnubok_search_tools'],
    ['item_id', 'gnubok_get_inbox_item', 'inbox_item_id', 'gnubok_list_skills'],
    ['item_id', 'gnubok_reconcile_unmatch', 'external_id', 'gnubok_search_tools'],
    ['tool', 'gnubok_search_tools', 'query', 'gnubok_list_skills'],
    ['description', 'gnubok_search_tools', 'query', 'gnubok_list_skills'],
    ['entry_id', 'gnubok_set_voucher_note', 'journal_entry_id', 'gnubok_list_skills'],
    ['note', 'gnubok_set_voucher_note', 'notes', 'gnubok_search_tools'],
    ['month', 'gnubok_list_salary_runs', 'period_month', 'gnubok_search_tools'],
    ['year', 'gnubok_list_salary_runs', 'period_year', 'gnubok_search_tools'],
    ['period_id', 'gnubok_close_period', 'fiscal_period_id', 'gnubok_list_skills'],
    ['date_from', 'gnubok_list_verifikat_without_documents', 'since', 'gnubok_list_skills'],
    ['from_date', 'gnubok_list_verifikat_without_documents', 'since', 'gnubok_list_skills'],
    ['start_date', 'gnubok_list_verifikat_without_documents', 'since', 'gnubok_list_skills'],
    ['until', 'gnubok_get_income_statement', 'to_date', 'gnubok_list_verifikat_without_documents'],
    ['until', 'gnubok_list_reconciliation_items', 'date_to', 'gnubok_list_transactions_without_documents'],
    ['date_to', 'gnubok_get_ar_ledger', 'as_of_date', 'gnubok_list_verifikat_without_documents'],
    ['offset', 'gnubok_list_salary_runs', 'cursor', 'gnubok_search_tools'],
  ])('%s -> %s names "%s"; %s gets no hint', (unknownKey, withTarget, expected, without) => {
    expect(hintOn(withTarget, unknownKey)).toBe(expected)
    expect(hintOn(without, unknownKey)).toBeNull()
  })

  it('never points an upper bound at the lower bound of a since-only list', () => {
    for (const key of ['until', 'date_to', 'to_date', 'end_date']) {
      expect(hintOn('gnubok_list_verifikat_without_documents', key), key).toBeNull()
    }
  })
})

describe('suggestArgKey: the structural fallback for id-shaped keys', () => {
  it('names the one key ending in _<subject>_id', () => {
    expect(suggestArgKey('run_id', ['salary_run_id', 'period_year'])).toBe('salary_run_id')
    expect(hintOn('gnubok_book_salary_run', 'run_id')).toBe('salary_run_id')
  })

  it('names the one key ending in <subject>_ref, then the one _ref key', () => {
    // resolve_missing takes document_ref; the table's record_ref is not there.
    expect(hintOn('gnubok_resolve_missing', 'document_id')).toBe('document_ref')
    expect(hintOn('gnubok_get_record', 'id')).toBe('record_ref')
    expect(hintOn('gnubok_get_fact_history', 'agreement_id')).toBe('subject_ref')
  })

  it('falls back to the only required key when it is an identifier', () => {
    expect(hintOn('gnubok_get_inbox_item', 'id')).toBe('inbox_item_id')
    // Not inbox_item_id, which credit_supplier_invoice also takes: a bare id
    // there means the invoice being credited. Why id is not in the table.
    expect(hintOn('gnubok_credit_supplier_invoice', 'id')).toBe('supplier_invoice_id')
    expect(hintOn('gnubok_update_account', 'account_id')).toBe('account_number')
  })

  it('names nothing on a tie, whatever the required keys say', () => {
    expect(
      suggestArgKey('document_id', ['source_document_id', 'target_document_id'], { required: ['source_document_id'] }),
    ).toBeNull()
    expect(suggestArgKey('id', ['record_ref', 'subject_ref'], { required: ['record_ref'] })).toBeNull()
  })

  it('never points an id at a required key that is not an identifier', () => {
    // gnubok_get_task requires kind ("bookkeep", "vat", ...), not a uuid.
    expect(hintOn('gnubok_get_task', 'operation_id')).toBeNull()
    expect(suggestArgKey('fact_id', ['content', 'kind'], { required: ['content'] })).toBeNull()
  })

  it('names nothing when the required key was sent too, or when there are two', () => {
    const validKeys = ['journal_entry_id', 'notes']
    const required = ['journal_entry_id']
    expect(suggestArgKey('voucher_id', validKeys, { required, args: { voucher_id: 'v-1' } })).toBe('journal_entry_id')
    expect(
      suggestArgKey('voucher_id', validKeys, { required, args: { journal_entry_id: 'je-1', voucher_id: 'v-1' } }),
    ).toBeNull()
    expect(hintOn('gnubok_reconcile_unmatch', 'id')).toBeNull()
  })

  it('only applies to id-shaped keys', () => {
    expect(suggestArgKey('invoice', ['invoice_id'], { required: ['invoice_id'] })).toBeNull()
    expect(suggestArgKey('uuid', ['invoice_id'], { required: ['invoice_id'] })).toBeNull()
  })
})

describe('describeArgHint', () => {
  const uuid = '0b8f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b'
  const hint = (toolName: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === toolName)!
    const schema = tool.inputSchema as Record<string, unknown>
    const context = { required: listRequiredArgKeys(schema), args }
    return Object.keys(args)
      .filter((key) => !listArgKeys(schema).includes(key))
      .map((key) => describeArgHint(key, listArgKeys(schema), context))
  }

  it('shows the exact record_ref for document_id with a uuid, in the form parseRecordRef reads', () => {
    const expected = `"document_id" -> "record_ref": "document:${uuid}"`
    expect(hint('gnubok_ask_document', { document_id: uuid, question: 'Vad är uppsägningstiden?' })).toEqual([expected])
    expect(hint('gnubok_get_record', { document_id: uuid })).toEqual([expected])
    expect(parseRecordRef(`document:${uuid}`)).toEqual({ kind: 'document', id: uuid })
  })

  it('builds the ref from record_type and record_id sent together', () => {
    expect(hint('gnubok_get_record', { record_type: 'document', record_id: uuid })).toEqual([
      '"record_type" -> "record_ref"',
      `"record_id" -> "record_ref": "document:${uuid}"`,
    ])
    expect(hint('gnubok_get_record', { record_type: 'Journal_Entry', record_id: uuid })[1]).toBe(
      `"record_id" -> "record_ref": "journal_entry:${uuid}"`,
    )
  })

  it('names the key without a value when the call does not say which record', () => {
    expect(hint('gnubok_ask_document', { document_id: '42', question: 'Vad kostar det?' })).toEqual([
      '"document_id" -> "record_ref"',
    ])
    expect(hint('gnubok_get_record', { record_id: uuid })).toEqual(['"record_id" -> "record_ref"'])
    expect(hint('gnubok_get_record', { record_type: 'invoice', record_id: uuid })[1]).toBe(
      '"record_id" -> "record_ref"',
    )
  })

  it('is the plain pair for every other key, and null with nothing to suggest', () => {
    expect(describeArgHint('note', ['notes', 'journal_entry_id'])).toBe('"note" -> "notes"')
    expect(describeArgHint('colour', ['notes'])).toBeNull()
  })
})
