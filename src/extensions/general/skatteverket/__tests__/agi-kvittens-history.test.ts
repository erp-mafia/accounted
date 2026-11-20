/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { readAgiKvittensReceipts, recordAgiKvittenser } from '../lib/agi-kvittens-history'

function makeSupabase(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const upserts: Array<{ rows: unknown[]; options: unknown }> = []
  const chain: any = {}
  for (const method of ['select', 'eq', 'order']) chain[method] = vi.fn(() => chain)
  chain.upsert = vi.fn((rows: unknown[], options: unknown) => {
    upserts.push({ rows, options })
    return chain
  })
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
  const supabase = { from: vi.fn(() => chain) } as any
  return { supabase, upserts }
}

const PERIOD = { year: 2026, month: 9 }

describe('recordAgiKvittenser', () => {
  it('writes nothing when no kvittens carries a uuidKvittens', async () => {
    const { supabase, upserts } = makeSupabase()
    const result = await recordAgiKvittenser(supabase, 'company-1', PERIOD, [{ arbetsgivare: 'x' } as any], 'cron')
    expect(result).toEqual({ ok: true, recorded: 0 })
    expect(upserts).toEqual([])
  })

  it('keeps the receipt as received and drops a signing time Postgres would refuse', async () => {
    const odd = { uuidKvittens: 'k-1', signeradTid: 'igår', signeradAv: '191212121212' }
    const { supabase, upserts } = makeSupabase()
    const result = await recordAgiKvittenser(supabase, 'company-1', PERIOD, [odd as any], 'post-connect')
    expect(result).toEqual({ ok: true, recorded: 1 })
    expect(upserts[0].rows).toEqual([
      {
        company_id: 'company-1',
        period_year: 2026,
        period_month: 9,
        uuid_kvittens: 'k-1',
        signerad_tid: null,
        receipt: odd,
        recorded_by: 'post-connect',
      },
    ])
  })

  it('answers the database error', async () => {
    const { supabase } = makeSupabase({ error: { message: 'permission denied' } })
    const result = await recordAgiKvittenser(supabase, 'company-1', PERIOD, [{ uuidKvittens: 'k-1' } as any], 'interactive')
    expect(result).toEqual({ ok: false, error: 'permission denied' })
  })
})

describe('readAgiKvittensReceipts', () => {
  it('maps rows to receipts, preferring the signing time as Skatteverket sent it', async () => {
    const { supabase } = makeSupabase({
      data: [
        { uuid_kvittens: 'k-2', signerad_tid: '2026-10-02T09:00:00+00:00', receipt: { signeradAv: '191212121212', signeradTid: '2026-10-02T09:00:00Z' } },
        { uuid_kvittens: 'k-1', signerad_tid: null, receipt: {} },
      ],
    })
    expect(await readAgiKvittensReceipts(supabase, 'company-1', 2026, 9)).toEqual([
      { kvittensnummer: 'k-2', signeradAv: '191212121212', signeradTid: '2026-10-02T09:00:00Z' },
      { kvittensnummer: 'k-1' },
    ])
  })

  it('answers none when the read fails', async () => {
    const { supabase } = makeSupabase({ error: { message: 'timeout' } })
    expect(await readAgiKvittensReceipts(supabase, 'company-1', 2026, 9)).toEqual([])
  })
})
