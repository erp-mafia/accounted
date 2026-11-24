/**
 * gnubok_list_verifikat_without_documents takes a since..until window. The
 * 2026-10 session autopsy found date_from/date_to refused 34 times in 30 days
 * on a list that took a lower bound only; the aliases map them onto since and
 * until (report-arg-aliases.ts), and until is a real bound in the RPC
 * (20261028103000, pinned by tests/pg/verifikat-without-documents-rpc.pg.test.ts).
 * Under test here: what the tool sends the RPC, and what it refuses first.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const list = tools.find((t) => t.name === 'gnubok_list_verifikat_without_documents')!

const PAGE = {
  ok: true,
  total_count: 1,
  verifikat: [
    {
      journal_entry_id: 'je-1',
      voucher_series: 'A',
      voucher_number: 4,
      entry_date: '2026-02-10',
      description: 'Kontorsmaterial',
      source_type: 'manual',
      gross_amount: 250,
    },
  ],
}

async function run(args: Record<string, unknown>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: PAGE })
  const result = await list.execute(args, 'company-1', 'user-1', supabase as never)
  return { result, rpc: supabase.rpc }
}

describe('gnubok_list_verifikat_without_documents: since and until', () => {
  it('sends until to the RPC as p_until, beside since', async () => {
    const { result, rpc } = await run({ since: '2026-01-01', until: '2026-03-31', limit: 10 })
    expect(rpc).toHaveBeenCalledWith('verifikat_without_documents', {
      p_company_id: 'company-1',
      p_since: '2026-01-01',
      p_min_amount: 0,
      p_limit: 10,
      p_offset: 0,
      p_until: '2026-03-31',
    })
    expect(result).toMatchObject({ verifikat: PAGE.verifikat, total_count: 1, count: 1, has_more: false })
  })

  it('calls the RPC as before when no until is sent', async () => {
    const { rpc } = await run({ since: '2026-01-01' })
    expect(rpc.mock.calls[0][1]).toEqual({
      p_company_id: 'company-1',
      p_since: '2026-01-01',
      p_min_amount: 0,
      p_limit: 20,
      p_offset: 0,
    })
  })

  it('takes until alone', async () => {
    const { rpc } = await run({ until: '2026-06-30' })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_since: null, p_until: '2026-06-30' })
  })

  it('refuses a bound that is not an ISO date, and a window that ends before it starts, before any read', async () => {
    for (const args of [{ until: '30/06/2026' }, { since: 20260101 }, { since: '2026-07-01', until: '2026-06-30' }]) {
      const { supabase } = createQueuedMockSupabase()
      await expect(list.execute(args, 'company-1', 'user-1', supabase as never), JSON.stringify(args)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  })
})

/**
 * Each row carries Kvittojakten's errand for it (nextStepKind, through
 * verifikatNextStepKinds), so an agent does not go looking for a receipt for
 * a transfer between own accounts, whose underlag is the bank statement.
 * gnubok_vat_close_check leaves the same own_transfer rows out of its count.
 */
describe('gnubok_list_verifikat_without_documents: next_step_kind', () => {
  const ROWS = [
    { ...PAGE.verifikat[0], journal_entry_id: 'je-transfer', description: 'Överföring till sparkonto', gross_amount: 100000 },
    { ...PAGE.verifikat[0], journal_entry_id: 'je-purchase', description: 'Kortköp', gross_amount: 5000 },
  ]
  const line = (entry: string, n: number, account_number: string, debit: number, credit = 0) => ({
    id: `${entry}-${n}`,
    journal_entry_id: entry,
    account_number,
    debit_amount: debit,
    credit_amount: credit,
  })

  function routedSupabase(tables: Record<string, unknown[]>, failing?: string) {
    return {
      rpc: () => Promise.resolve({ data: { ok: true, total_count: ROWS.length, verifikat: ROWS }, error: null }),
      from(table: string) {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order']) chain[m] = () => chain
        const settled = table === failing
          ? { data: null, error: { message: 'timeout' } }
          : { data: tables[table] ?? [], error: null }
        chain.range = () => Promise.resolve(settled)
        chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settled).then(resolve)
        return chain
      },
    }
  }

  const TABLES = {
    transactions: [{ journal_entry_id: 'je-purchase', merchant_name: 'Kontorsgiganten', amount: -5000, currency: 'SEK' }],
    journal_entry_lines: [
      line('je-transfer', 1, '1940', 100000), line('je-transfer', 2, '1930', 0, 100000),
      line('je-purchase', 1, '5410', 4000), line('je-purchase', 2, '2640', 1000), line('je-purchase', 3, '1930', 0, 5000),
    ],
  }

  it('gives a transfer between own accounts own_transfer, and a purchase the errand of its name', async () => {
    const result = (await list.execute({}, 'company-1', 'user-1', routedSupabase(TABLES) as never)) as {
      verifikat: { journal_entry_id: string; next_step_kind: string | null }[]
    }
    expect(result.verifikat.map((r) => [r.journal_entry_id, r.next_step_kind])).toEqual([
      ['je-transfer', 'own_transfer'],
      ['je-purchase', 'mail'],
    ])
    expect(result).toMatchObject({ total_count: 2, count: 2 })
  })

  it('still lists the rows, with next_step_kind null, when the errand cannot be read', async () => {
    const result = (await list.execute({}, 'company-1', 'user-1', routedSupabase(TABLES, 'journal_entry_lines') as never)) as {
      verifikat: { journal_entry_id: string; next_step_kind: string | null }[]
    }
    expect(result.verifikat.map((r) => [r.journal_entry_id, r.next_step_kind])).toEqual([
      ['je-transfer', null],
      ['je-purchase', null],
    ])
  })
})
