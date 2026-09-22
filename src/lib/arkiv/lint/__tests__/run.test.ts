import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { EXPECTATION_RULES } from '../checks'
import { computeAutonomy, lintCompany } from '../run'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => reset())

/** The reads lintCompany makes, in order, before it files anything. */
function enqueueInputs(input: {
  facts?: unknown[]
  settings?: Record<string, unknown> | null
  agreements?: unknown[]
  contents?: unknown[]
  jobs?: unknown[]
  existing?: unknown[]
  ledger?: unknown[]
  balanceLedger?: unknown[]
}) {
  enqueue({ data: input.facts ?? [] })
  enqueue({ data: input.settings ?? null })
  enqueue({ data: input.agreements ?? [] })
  enqueue({ data: input.contents ?? [] })
  enqueue({ data: input.jobs ?? [] })
  enqueue({ data: input.ledger ?? [] }) // cost accounts, twelve months
  enqueue({ data: input.balanceLedger ?? [] }) // balance accounts, all time
  enqueue({ data: input.existing ?? [] })
}

describe('lintCompany', () => {
  it('files a new finding, refreshes one still true, reopens a resolved one, and closes what went away', async () => {
    enqueueInputs({
      facts: [{ id: 'f-1', predicate: 'vat_period', value_text: 'helt beskattningsår', source_document_id: 'doc-1', sources: [{ page: 1 }] }],
      settings: {
        company_name: 'Arcim',
        org_number: null,
        f_skatt: true,
        vat_registered: true,
        employer_registered: null,
        moms_period: 'quarterly',
        accounting_method: 'accrual',
        fiscal_year_start_month: 1,
      },
      agreements: [
        { id: 'a-1', kind: 'rental', title: 'Hyresavtal', status: 'active', starts_on: null, ends_on: '2026-10-01', amount: null, principal: null, notice_months: null, counterparty_party_id: 'p-1', counterparty_name: 'Lokalen' },
        { id: 'a-2', kind: 'loan', title: 'Lån', status: 'active', starts_on: null, ends_on: null, amount: null, principal: null, notice_months: null, counterparty_party_id: null, counterparty_name: 'Almi' },
      ],
      jobs: [{ document_id: 'doc-9', kind: 'read', attempts: 5, max_attempts: 5, last_error: 'boom', document_attachments: { file_name: 'scan.pdf' } }],
      existing: [
        { id: 'x-1', key: 'settings_mismatch:moms_period', status: 'open' },
        { id: 'x-2', key: 'agreement_ending:a-1', status: 'resolved' },
        { id: 'x-3', key: 'duplicate_document:gone', status: 'open' },
        { id: 'x-4', key: 'agreement_no_counterparty:a-2', status: 'dismissed' },
      ],
    })
    enqueue({}) // refresh x-1
    enqueue({}) // reopen x-2
    enqueue({}) // refresh x-4 (stays dismissed)
    enqueue({}) // insert document_stuck:doc-9
    enqueue({}) // close x-3
    enqueue({ data: [] }) // activities

    const out = await lintCompany(supabase, 'co-1', '2026-09-15')

    expect(out).toEqual({ findings: 4, opened: 2, closed: 1, autonomy: 0 })
    const inserts = findCalls('arkiv_findings', 'insert').map((a) => a[0] as Record<string, unknown>)
    expect(inserts).toEqual([
      expect.objectContaining({
        company_id: 'co-1',
        kind: 'document_stuck',
        key: 'document_stuck:doc-9',
        status: 'open',
        detail: { file_name: 'scan.pdf', step: 'read', last_error: 'boom' },
      }),
    ])
    const updates = findCalls('arkiv_findings', 'update').map((a) => a[0] as Record<string, unknown>)
    expect(updates[0]).toMatchObject({ detail: expect.objectContaining({ field: 'moms_period', proposed: 'yearly' }), last_seen_at: expect.any(String) })
    expect(updates[0]).not.toHaveProperty('status')
    expect(updates[1]).toMatchObject({ status: 'open', resolution: null, resolved_at: null })
    expect(updates[2]).not.toHaveProperty('status')
    expect(updates[3]).toEqual({ status: 'resolved', resolution: 'gone', resolved_at: expect.any(String) })
  })

  it('ignores a failed job that still has attempts left', async () => {
    enqueueInputs({ jobs: [{ document_id: 'doc-1', kind: 'extract', attempts: 2, max_attempts: 5, last_error: 'retry', document_attachments: { file_name: 'a.pdf' } }] })
    enqueue({ data: [] })
    expect(await lintCompany(supabase, 'co-1', '2026-09-15')).toEqual({ findings: 0, opened: 0, closed: 0, autonomy: 0 })
    expect(findCalls('arkiv_findings', 'insert')).toEqual([])
  })

  it('throws with the failing step when a read fails', async () => {
    enqueue({ error: { message: 'timeout' } })
    await expect(lintCompany(supabase, 'co-1', '2026-09-15')).rejects.toThrow('facts fetch failed: timeout')
  })
})

describe('computeAutonomy', () => {
  it('writes one level per schema type from the audits of the window', async () => {
    enqueue({
      data: [
        ...Array.from({ length: 12 }, () => ({ schema_type: 'agreement.loan', detail: { audit: { field: 'principal', changed: false } } })),
        { schema_type: 'agreement.loan', detail: { audit: { field: 'principal', changed: true } } },
        { schema_type: 'receipt', detail: { fields: ['total_amount'] } },
      ],
    })
    enqueue({})
    expect(await computeAutonomy(supabase, 'co-1', '2026-09-15')).toBe(1)
    expect(findCalls('activities', 'gte')).toEqual([['started_at', '2026-06-17']])
    expect(findCalls('arkiv_autonomy', 'upsert')[0]).toEqual([
      { company_id: 'co-1', schema_type: 'agreement.loan', level: 1, audited: 13, changed: 1, computed_at: expect.any(String) },
      { onConflict: 'company_id,schema_type' },
    ])
  })
})

describe('ledger evidence', () => {
  it('pins the ledger filter to the expectation rules, so a new rule cannot be forgotten in the query', async () => {
    enqueueInputs({})
    enqueue({ data: [] }) // activities
    enqueue({ data: null }) // autonomy
    await lintCompany(supabase, 'co-1', '2026-10-01')
    const split = (filter: unknown) => String(filter).split(',and(').map((x, i) => (i === 0 ? x : 'and(' + x))
    const range = (r: { from: string; to: string }) => `and(account_number.gte.${r.from},account_number.lte.${r.to})`
    const [costSent, balanceSent] = findCalls('journal_entry_lines', 'or').map((c) => split(c[0]))
    expect(costSent.sort()).toEqual(EXPECTATION_RULES.flatMap((r) => (r.cost ? [range(r.cost)] : [])).sort())
    expect(balanceSent.sort()).toEqual(EXPECTATION_RULES.flatMap((r) => (r.balance ?? []).map(range)).sort())
    // The cost query has a date floor, the balance query has none: a standing balance is evidence whether or not it moved this year.
    expect(findCalls('journal_entry_lines', 'gte')).toHaveLength(1)
    // A storno cancels its original only when both are summed: reversed entries stay in, as in the reports.
    expect(findCalls('journal_entry_lines', 'in')).toEqual([['journal_entries.status', ['posted', 'reversed']], ['journal_entries.status', ['posted', 'reversed']]])
  })
})
