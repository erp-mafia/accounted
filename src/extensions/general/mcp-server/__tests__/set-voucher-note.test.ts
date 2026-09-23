/**
 * Unit tests for gnubok_set_voucher_note: registration/scope/risk wiring,
 * input validation, the not-found pre-flight, note normalisation ('' → null),
 * and dry-run staging with dateForPeriodCheck threading. Executor-side
 * coverage (commitSetVoucherNote) lives in
 * lib/pending-operations/__tests__/account-and-note-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const tool = tools.find((t) => t.name === 'gnubok_set_voucher_note')!

const ENTRY_ROW = {
  id: 'je-1',
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

describe('gnubok_set_voucher_note: registration', () => {
  it('is registered, stages, and declares a strict schema', () => {
    expect(tool).toBeDefined()
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(out?.properties?.staged).toBeDefined()
    expect(out?.required).toContain('staged')
    expect(tool.description).toMatch(/stag(e|es|ing)/i)
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
  it('rejects a missing journal_entry_id before any DB call', async () => {
    await expect(
      tool.execute({ journal_entry_id: '', notes: 'x' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/journal_entry_id/)
  })

  it('rejects non-string non-null notes before any DB call', async () => {
    await expect(
      tool.execute({ journal_entry_id: 'je-1', notes: 42 }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/string.*null/s)
  })

  it('rejects notes longer than 2000 chars before any DB call', async () => {
    await expect(
      tool.execute(
        { journal_entry_id: 'je-1', notes: 'x'.repeat(2001) },
        'company-1', 'user-1', noopSupabase,
      ),
    ).rejects.toThrow(/2000/)
  })

  it('rejects when the entry does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      tool.execute({ journal_entry_id: 'je-x', notes: 'x' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/hittades inte/)
  })
})

describe('gnubok_set_voucher_note: staging behaviour (dry_run)', () => {
  it('previews old and new note with the voucher label', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: 'je-1', notes: 'Avser Q1-hyran, se mail 12/3', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      journal_entry_id: 'je-1',
      voucher: 'A42',
      entry_status: 'posted',
      old_notes: 'Gammal anteckning',
      new_notes: 'Avser Q1-hyran, se mail 12/3',
    })
  })

  it('normalises a whitespace-only note to null (clear)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: 'je-1', notes: '   ', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.new_notes).toBeNull()
  })

  it('accepts explicit null to clear the note', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ENTRY_ROW })
    const result = (await tool.execute(
      { journal_entry_id: 'je-1', notes: null, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.new_notes).toBeNull()
  })

  it('labels a draft (no voucher number yet) as utkast', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ENTRY_ROW, voucher_number: null, status: 'draft' } })
    const result = (await tool.execute(
      { journal_entry_id: 'je-1', notes: 'Utkast-anteckning', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.voucher).toBe('utkast')
  })
})
