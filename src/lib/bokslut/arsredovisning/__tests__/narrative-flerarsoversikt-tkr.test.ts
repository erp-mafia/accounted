/**
 * arsredovisning_narratives.flerarsoversikt_tkr while its migration has not
 * run: the code is live a few minutes before the column exists, so a read
 * and a save must keep working without it. A read falls back to the columns
 * before it (the year is then stated in kronor, which is what a database
 * without the column holds). A save goes through without the column unless
 * it turns tkr on: that choice cannot be stored yet, so the save fails
 * instead of losing it silently.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getNarrative, upsertNarrative } from '../narrative-service'

const TABLE = 'arsredovisning_narratives'

const narrativeRow = {
  id: 'narrative-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  description: 'Bolaget bedriver konsultverksamhet.',
  updated_at: '2026-01-15T10:00:00Z',
}

/** What PostgREST answers when a selected column does not exist. */
const undefinedColumn = Object.assign(new Error('column arsredovisning_narratives.flerarsoversikt_tkr does not exist'), {
  name: 'PostgrestError',
  code: '42703',
  details: null,
  hint: null,
})

/** What PostgREST answers when a written column is not in its schema cache. */
const unknownColumn = Object.assign(
  new Error("Could not find the 'flerarsoversikt_tkr' column of 'arsredovisning_narratives' in the schema cache"),
  { name: 'PostgrestError', code: 'PGRST204', details: null, hint: null },
)

const client = (supabase: unknown) => supabase as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getNarrative', () => {
  it('reads flerarsoversikt_tkr with the row', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...narrativeRow, flerarsoversikt_tkr: true } })
    const row = await getNarrative(client(supabase), 'company-1', 'period-1')
    expect(row?.flerarsoversikt_tkr).toBe(true)
    const selects = findCalls(TABLE, 'select').map((args) => String(args[0]))
    expect(selects).toHaveLength(1)
    expect(selects[0]).toContain('flerarsoversikt_tkr')
  })

  it('reads the columns before it on a database without the column', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: undefinedColumn })
    enqueue({ data: narrativeRow })
    const row = await getNarrative(client(supabase), 'company-1', 'period-1')
    // The texts the user wrote are still read; the year is stated in kronor.
    expect(row).toEqual(narrativeRow)
    expect(row?.flerarsoversikt_tkr).toBeUndefined()
    const [first, retry] = findCalls(TABLE, 'select').map((args) => String(args[0]))
    expect(first).toContain('flerarsoversikt_tkr')
    // The retry asks for everything else the first read asked for.
    expect(retry).toBe(first.replace(', flerarsoversikt_tkr', ''))
  })

  it('does not retry a read that failed for another reason', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('permission denied for table arsredovisning_narratives'), {
        name: 'PostgrestError',
        code: '42501',
      }),
    })
    enqueue({ data: narrativeRow })
    await expect(getNarrative(client(supabase), 'company-1', 'period-1')).rejects.toMatchObject({ code: '42501' })
    expect(findCalls(TABLE, 'select')).toHaveLength(1)
  })
})

describe('upsertNarrative', () => {
  it('saves the choice and reads it back', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...narrativeRow, flerarsoversikt_tkr: true } })
    const row = await upsertNarrative(client(supabase), 'company-1', 'user-1', 'period-1', { flerarsoversikt_tkr: true })
    expect(row.flerarsoversikt_tkr).toBe(true)
    const writes = findCalls(TABLE, 'upsert')
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toMatchObject({ company_id: 'company-1', fiscal_period_id: 'period-1', flerarsoversikt_tkr: true })
    expect(String(findCalls(TABLE, 'select')[0][0])).toContain('flerarsoversikt_tkr')
  })

  it('saves the other fields on a database without the column', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: undefinedColumn })
    enqueue({ data: narrativeRow })
    const row = await upsertNarrative(client(supabase), 'company-1', 'user-1', 'period-1', {
      description: 'Bolaget bedriver konsultverksamhet.',
    })
    expect(row).toEqual(narrativeRow)
    const [first, retry] = findCalls(TABLE, 'select').map((args) => String(args[0]))
    expect(first).toContain('flerarsoversikt_tkr')
    expect(retry).not.toContain('flerarsoversikt_tkr')
    // Both attempts write the same row: only what is read back differs.
    const writes = findCalls(TABLE, 'upsert').map((args) => args[0])
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
  })

  it('saves a year that leaves tkr off without the column: off is what the database holds', async () => {
    // The editor sends the choice with every save, so this is every save made
    // in the minutes before the migration has run.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: unknownColumn })
    enqueue({ data: narrativeRow })
    const row = await upsertNarrative(client(supabase), 'company-1', 'user-1', 'period-1', {
      description: 'Bolaget bedriver konsultverksamhet.',
      flerarsoversikt_tkr: false,
    })
    expect(row).toEqual(narrativeRow)
    const [first, retry] = findCalls(TABLE, 'upsert').map((args) => args[0] as Record<string, unknown>)
    expect(first).toMatchObject({ description: 'Bolaget bedriver konsultverksamhet.', flerarsoversikt_tkr: false })
    expect(retry).toMatchObject({ description: 'Bolaget bedriver konsultverksamhet.' })
    expect(retry).not.toHaveProperty('flerarsoversikt_tkr')
    expect(String(findCalls(TABLE, 'select')[1][0])).not.toContain('flerarsoversikt_tkr')
  })

  it('fails a save that turns tkr on instead of losing the choice', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: unknownColumn })
    enqueue({ data: narrativeRow })
    const error = await upsertNarrative(client(supabase), 'company-1', 'user-1', 'period-1', {
      description: 'Bolaget bedriver konsultverksamhet.',
      flerarsoversikt_tkr: true,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'PGRST204' })
    // One attempt only: no retry without the column.
    expect(findCalls(TABLE, 'upsert')).toHaveLength(1)
  })

  it('does not retry a save that failed for another reason', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: Object.assign(new Error('violates check constraint'), { name: 'PostgrestError', code: '23514' }) })
    enqueue({ data: narrativeRow })
    await expect(
      upsertNarrative(client(supabase), 'company-1', 'user-1', 'period-1', { description: 'x' }),
    ).rejects.toMatchObject({ code: '23514' })
    expect(findCalls(TABLE, 'upsert')).toHaveLength(1)
  })
})
