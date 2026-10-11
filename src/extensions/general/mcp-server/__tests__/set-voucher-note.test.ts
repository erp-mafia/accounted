/**
 * gnubok_set_voucher_note is generated from the operation
 * journal-entries.set-note (lib/operations/journal-entries.ts): the same
 * input, rules and service (setJournalEntryNote) as the v1 endpoint. These
 * tests pin what the agent and the approver see: the registration, the
 * validation, the not-found pre-flight, note normalisation ('' → null), the
 * approval preview and title, and the period status of the entry's date.
 * The commit side lives in
 * lib/pending-operations/__tests__/account-and-note-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const tool = tools.find((t) => t.name === 'gnubok_set_voucher_note')!

const JE_ID = '3f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

const ENTRY_ROW = {
  id: JE_ID,
  voucher_series: 'A',
  voucher_number: 42,
  entry_date: '2026-03-15',
  description: 'Hyra mars',
  status: 'posted',
  notes: 'Gammal anteckning',
}

const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

type Staged = {
  dry_run?: boolean
  preview: Record<string, unknown>
  period_status?: Record<string, unknown>
}

describe('gnubok_set_voucher_note: registration', () => {
  it('is registered, stages, stays in tools/list and declares a strict schema', () => {
    expect(tool).toBeDefined()
    expect(tool.catalogVisibility).toBe('default')
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(out?.properties?.staged).toBeDefined()
    expect(out?.required).toContain('staged')
    expect(tool.description).toMatch(/stag(e|es|ing)/i)
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })
  })

  it('requires journal_entry_id AND notes (explicit null to clear, never implicit)', () => {
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(['journal_entry_id', 'notes'])
  })

  it('is mapped to bookkeeping:write scope and low risk tier', () => {
    expect(TOOL_SCOPE_MAP.gnubok_set_voucher_note).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.set_voucher_note).toBe('low')
  })
})

describe('gnubok_set_voucher_note: validation gates', () => {
  it.each([
    ['a missing journal_entry_id', { notes: 'x' }],
    ['non-string non-null notes', { journal_entry_id: JE_ID, notes: 42 }],
    ['notes longer than 2000 chars', { journal_entry_id: JE_ID, notes: 'x'.repeat(2001) }],
  ])('rejects %s as VALIDATION_ERROR before any DB call', async (_case, args) => {
    await expect(tool.execute(args, 'company-1', 'user-1', noopSupabase)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('rejects when the entry does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      tool.execute({ journal_entry_id: JE_ID, notes: 'x' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_FOUND' })
  })
})

describe('gnubok_set_voucher_note: staging behaviour (dry_run)', () => {
  it('previews old and new note with the voucher label', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: JE_ID, notes: 'Avser Q1-hyran, se mail 12/3', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.dry_run).toBe(true)
    expect(result.preview).toEqual({
      journal_entry_id: JE_ID,
      voucher: 'A42',
      entry_description: 'Hyra mars',
      entry_status: 'posted',
      old_notes: 'Gammal anteckning',
      new_notes: 'Avser Q1-hyran, se mail 12/3',
    })
  })

  it('normalises a whitespace-only note to null (clear)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: JE_ID, notes: '   ', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview.new_notes).toBeNull()
  })

  it('accepts explicit null to clear the note', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: JE_ID, notes: null, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview.new_notes).toBeNull()
  })

  it('labels a draft (no voucher number yet) as utkast', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ENTRY_ROW, voucher_number: null, status: 'draft' } })
    const result = (await tool.execute(
      { journal_entry_id: JE_ID, notes: 'Utkast-anteckning', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(result.preview.voucher).toBe('utkast')
  })

  it('reports the period status of the entry date', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW }) // journal_entries dry-run read
    enqueue({ data: null }) // company_settings: no company lock date
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: '2026-04-01T00:00:00Z' } }) // covering period
    const result = (await tool.execute(
      { journal_entry_id: JE_ID, notes: 'x', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as Staged

    expect(findCalls('fiscal_periods', 'lte')).toContainEqual(['period_start', '2026-03-15'])
    expect(result.period_status).toMatchObject({ period_id: 'fp-1', status: 'locked' })
  })

  it('stages with the title the approver reads', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW }) // journal_entries dry-run read
    enqueue({ data: null }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    enqueue({ data: { id: 'op-note-1' } }) // pending_operations insert

    await tool.execute({ journal_entry_id: JE_ID, notes: null }, 'company-1', 'user-1', supabase as never)

    expect(findCalls('pending_operations', 'insert')[0]?.[0]).toMatchObject({
      operation_type: 'set_voucher_note',
      title: 'Rensa anteckning på verifikat A42',
      params: { journal_entry_id: JE_ID, notes: null },
    })
  })
})
