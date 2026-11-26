/**
 * Error-contract tests for the årsredovisning narrative service.
 *
 * The service used to re-wrap Supabase's PostgrestError in a plain
 * `new Error(...)`, which kept only `.message` and dropped `.code`. Without the
 * SQLSTATE, errorResponse() could not recognise the failure as a Postgres
 * constraint violation and returned INTERNAL_ERROR / 500 for what is a caller
 * mistake. These tests pin the SQLSTATE pass-through and the resulting envelope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { errorResponse, type ErrorEnvelope } from '@/lib/errors/get-structured-error'
import { getNarrative, listFixedAssetNoteRows, saveMergedNarrative, upsertNarrative, type NarrativeRow } from '../narrative-service'

const noopLogger = { error: () => {}, warn: () => {} }

/**
 * Shape PostgREST actually returns for a failed CHECK: the constraint name is
 * in `message`, the failing row in `details`, and the SQLSTATE in `code`.
 */
function checkViolation(constraint: string) {
  return Object.assign(
    new Error(
      `new row for relation "arsredovisning_narratives" violates check constraint "${constraint}"`,
    ),
    {
      name: 'PostgrestError',
      code: '23514',
      details: 'Failing row contains (...)',
      hint: null,
    },
  )
}

async function envelopeFor(err: unknown): Promise<{ status: number; body: ErrorEnvelope }> {
  const res = errorResponse(err, noopLogger, { requestId: 'req_test' })
  return { status: res.status, body: (await res.json()) as ErrorEnvelope }
}

const narrativeRow = {
  id: 'narrative-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  description: 'Bolaget bedriver konsultverksamhet.',
  agm_disposition_outcome: null,
  agm_disposition_decision: null,
  updated_at: '2026-01-15T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('upsertNarrative', () => {
  it('returns the persisted row on the happy path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: narrativeRow })
    const result = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'Bolaget bedriver konsultverksamhet.' },
    )
    expect(result).toEqual(narrativeRow)
  })

  it('preserves the Postgres SQLSTATE on a CHECK violation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('arsredovisning_narratives_agm_decision_consistency') })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { agm_disposition_outcome: 'alternative_decision' },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: '23514' })
    expect((err as Error).message).toContain(
      'arsredovisning_narratives_agm_decision_consistency',
    )
  })

  it('maps a CHECK violation to 400 with a Swedish message', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: checkViolation('arsredovisning_narratives_agm_decision_consistency') })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { agm_disposition_decision: '   ' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('Några uppgifter stämmer inte. Kontrollera fälten och försök igen.')
    expect(body.error.details).toMatchObject({ pgCode: '23514' })
    // The failing row must not reach the client.
    expect(JSON.stringify(body)).not.toContain('Failing row')
  })

  it('still yields 500 for a genuine internal database failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('internal error occurred'), {
        name: 'PostgrestError',
        // XX000 internal_error: not a caller mistake, must not become a 400.
        code: 'XX000',
        details: null,
        hint: null,
      }),
    })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'x' },
    ).catch((e: unknown) => e)

    const { status, body } = await envelopeFor(err)
    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  it('still yields 500 when the write reports no row and no error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const err = await upsertNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      'period-1',
      { description: 'x' },
    ).catch((e: unknown) => e)

    expect((await envelopeFor(err)).status).toBe(500)
  })
})

// The keyed fields merge into the stored ones, so the merge is made from a
// read and written only on the row it was made from (#3768): another save
// landing in between sends it back to read and merge again.
describe('saveMergedNarrative', () => {
  const answered = (stored: NarrativeRow | null) => ({
    disclosure_answers: { ...(stored?.disclosure_answers ?? {}), 'fb.agare': { applies: false } },
  })
  const rowWith = (answers: Record<string, unknown>, updatedAt: string) => ({
    ...narrativeRow,
    disclosure_answers: answers,
    updated_at: updatedAt,
  })
  const save = (supabase: unknown, merge: Parameters<typeof saveMergedNarrative>[4] = answered) =>
    saveMergedNarrative(supabase as SupabaseClient, 'company-1', 'user-1', 'period-1', merge)
  const versionsWritten = (calls: { table: string; method: string; args: unknown[] }[]) =>
    calls.filter((call) => call.method === 'eq' && call.args[0] === 'updated_at').map((call) => call.args[1])

  it('writes the merge on the updated_at it was read with', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    const stored = rowWith({ 'not.rattelse': { applies: false } }, '2026-01-15T10:00:00.123456+00:00')
    enqueue({ data: stored })
    enqueue({ data: { ...stored, updated_at: '2026-01-15T10:00:01+00:00' } })
    const result = await save(supabase)
    expect(result?.updated_at).toBe('2026-01-15T10:00:01+00:00')
    expect(findCalls('arsredovisning_narratives', 'update')[0]?.[0]).toMatchObject({
      user_id: 'user-1',
      disclosure_answers: { 'not.rattelse': { applies: false }, 'fb.agare': { applies: false } },
    })
    expect(versionsWritten(calls)).toEqual(['2026-01-15T10:00:00.123456+00:00'])
    expect(findCalls('arsredovisning_narratives', 'upsert')).toEqual([])
  })

  it('reads and merges again when another save changed the row in between', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: rowWith({}, 'v1') })
    enqueue({ data: null }) // the conditional update matched no row
    enqueue({ data: rowWith({ 'fb.fortlevnad': { applies: false } }, 'v2') })
    enqueue({ data: rowWith({}, 'v3') })
    const merge = vi.fn(answered)
    expect(await save(supabase, merge)).not.toBeNull()
    expect(merge.mock.calls.map(([stored]) => stored?.updated_at)).toEqual(['v1', 'v2'])
    expect(versionsWritten(calls)).toEqual(['v1', 'v2'])
    // The other save's answer is kept.
    expect(findCalls('arsredovisning_narratives', 'update')[1]?.[0]).toMatchObject({
      disclosure_answers: { 'fb.fortlevnad': { applies: false }, 'fb.agare': { applies: false } },
    })
  })

  it('creates a missing row with a plain insert and merges into the row another save created first', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ error: Object.assign(new Error('duplicate key value violates unique constraint'), { name: 'PostgrestError', code: '23505' }) })
    enqueue({ data: rowWith({ 'fb.fortlevnad': { applies: false } }, 'v1') })
    enqueue({ data: rowWith({}, 'v2') })
    expect(await save(supabase)).not.toBeNull()
    expect(findCalls('arsredovisning_narratives', 'insert')[0]?.[0]).toMatchObject({
      company_id: 'company-1',
      fiscal_period_id: 'period-1',
      disclosure_answers: { 'fb.agare': { applies: false } },
    })
    expect(findCalls('arsredovisning_narratives', 'upsert')).toEqual([])
    expect(versionsWritten(calls)).toEqual(['v1'])
    expect(findCalls('arsredovisning_narratives', 'update')[0]?.[0]).toMatchObject({
      disclosure_answers: { 'fb.fortlevnad': { applies: false }, 'fb.agare': { applies: false } },
    })
  })

  it('gives up after five attempts that each met another save: null, nothing more written', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      enqueue({ data: rowWith({}, `v${attempt}`) })
      enqueue({ data: null })
    }
    expect(await save(supabase)).toBeNull()
    expect(findCalls('arsredovisning_narratives', 'update')).toHaveLength(5)
  })

  it('throws any other error with its SQLSTATE, without trying again', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rowWith({}, 'v1') })
    enqueue({ error: checkViolation('arsredovisning_narratives_agm_decision_consistency') })
    await expect(save(supabase)).rejects.toMatchObject({ code: '23514' })
    expect(findCalls('arsredovisning_narratives', 'update')).toHaveLength(1)
  })
})

describe('getNarrative', () => {
  it('returns null when nothing has been customised yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await getNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    )
    expect(result).toBeNull()
  })

  it('preserves the Postgres SQLSTATE on a read failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      error: Object.assign(new Error('permission denied for table arsredovisning_narratives'), {
        name: 'PostgrestError',
        code: '42501',
        details: null,
        hint: null,
      }),
    })
    const err = await getNarrative(
      supabase as unknown as SupabaseClient,
      'company-1',
      'period-1',
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: '42501' })
    expect((await envelopeFor(err)).status).toBe(403)
  })
})

// fixed_asset_note_rows and, after it, flerarsoversikt_tkr are newer than the
// base columns: the code is live before a column's migration has run, so the
// service must keep working without them (the second one alone:
// narrative-flerarsoversikt-tkr.test.ts).
describe('a database without the newer columns', () => {
  const missingColumn = Object.assign(new Error('column arsredovisning_narratives.fixed_asset_note_rows does not exist'), {
    name: 'PostgrestError',
    code: '42703',
    details: null,
    hint: null,
  })

  /** The columns each read or write asked for, in order: the first names every column, each retry one fewer. */
  const selectedColumns = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((call) => call.method === 'select').map((call) => String(call.args[0]))

  it('reads the narrative with the columns before it', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    // Without fixed_asset_note_rows the database lacks the column after it
    // too (migrations run in order): one retry per column left out.
    enqueue({ error: missingColumn })
    enqueue({ error: missingColumn })
    enqueue({ data: narrativeRow })
    const result = await getNarrative(supabase as unknown as SupabaseClient, 'company-1', 'period-1')
    expect(result).toEqual(narrativeRow)
    const [first, second, last] = selectedColumns(calls)
    expect(first).toContain('fixed_asset_note_rows')
    expect(second).toBe(first.replace(', flerarsoversikt_tkr', ''))
    expect(last).not.toContain('fixed_asset_note_rows')
    // The last read asks for everything else the first read asked for.
    expect(last).toBe(first.replace(', fixed_asset_note_rows, flerarsoversikt_tkr', ''))
  })

  it('saves the other fields with the columns before it', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ error: missingColumn })
    enqueue({ error: missingColumn })
    enqueue({ data: narrativeRow })
    const result = await upsertNarrative(supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'period-1', {
      description: 'Bolaget bedriver konsultverksamhet.',
    })
    expect(result).toEqual(narrativeRow)
    const [first, , last] = selectedColumns(calls)
    expect(first).toContain('fixed_asset_note_rows')
    expect(last).not.toContain('fixed_asset_note_rows')
    // Every attempt writes the same row: the fallback changes what is read back, not what is saved.
    const writes = calls.filter((call) => call.method === 'upsert').map((call) => call.args[0])
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[2]).toEqual(writes[0])
  })

  it('fails a save of the stated rows themselves instead of losing them', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    const unknownColumn = Object.assign(new Error("Could not find the 'fixed_asset_note_rows' column"), { name: 'PostgrestError', code: 'PGRST204' })
    enqueue({ error: unknownColumn })
    enqueue({ error: unknownColumn })
    enqueue({ data: narrativeRow })
    const stated = { ByggnaderMark: { 'cost.omrakningsdifferenser': 100_000 } }
    const err = await upsertNarrative(supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'period-1', {
      fixed_asset_note_rows: stated,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'PGRST204' })
    // Tried again without the column after it, never without the rows.
    const writes = calls.filter((call) => call.method === 'upsert').map((call) => call.args[0])
    expect(writes).toHaveLength(2)
    for (const write of writes) expect(write).toMatchObject({ fixed_asset_note_rows: stated })
  })

  it('saves the stated rows on a database that only lacks the column after them', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ error: Object.assign(new Error('column arsredovisning_narratives.flerarsoversikt_tkr does not exist'), { name: 'PostgrestError', code: '42703' }) })
    enqueue({ data: narrativeRow })
    const stated = { ByggnaderMark: { 'cost.omrakningsdifferenser': 100_000 } }
    const result = await upsertNarrative(supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'period-1', {
      fixed_asset_note_rows: stated,
      flerarsoversikt_tkr: false,
    })
    expect(result).toEqual(narrativeRow)
    const [first, retry] = calls.filter((call) => call.method === 'upsert').map((call) => call.args[0] as Record<string, unknown>)
    expect(first).toMatchObject({ fixed_asset_note_rows: stated, flerarsoversikt_tkr: false })
    expect(retry).toMatchObject({ fixed_asset_note_rows: stated })
    expect(retry).not.toHaveProperty('flerarsoversikt_tkr')
    // The rows are still read back.
    expect(selectedColumns(calls)[1]).toContain('fixed_asset_note_rows')
  })

  it('has no stated rows of earlier years to read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: missingColumn })
    const rows = await listFixedAssetNoteRows(supabase as unknown as SupabaseClient, 'company-1')
    expect(rows.size).toBe(0)
  })
})

describe('listFixedAssetNoteRows', () => {
  it('returns the stated rows of every year by fiscal period, normalised', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { fiscal_period_id: 'period-1', fixed_asset_note_rows: { ByggnaderMark: { 'cost.omrakningsdifferenser': 200_000, 'cost.inkop': 5 } } },
        { fiscal_period_id: 'period-2', fixed_asset_note_rows: {} },
        { fiscal_period_id: 'period-3', fixed_asset_note_rows: null },
      ],
    })
    const rows = await listFixedAssetNoteRows(supabase as unknown as SupabaseClient, 'company-1')
    expect([...rows.entries()]).toEqual([
      ['period-1', { ByggnaderMark: { 'cost.omrakningsdifferenser': 200_000 } }],
      ['period-2', {}],
      ['period-3', {}],
    ])
  })

  it('throws on a read failure: the note would open with the wrong balance', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: Object.assign(new Error('connection reset'), { name: 'PostgrestError', code: '08006' }) })
    await expect(listFixedAssetNoteRows(supabase as unknown as SupabaseClient, 'company-1')).rejects.toThrow(
      /Failed to load the stated rows of the anläggningstillgångar note: connection reset/,
    )
  })
})
