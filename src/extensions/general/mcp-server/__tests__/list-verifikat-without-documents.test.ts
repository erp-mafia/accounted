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
