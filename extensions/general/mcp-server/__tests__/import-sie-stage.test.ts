/**
 * Stage-time validation for gnubok_import_sie.
 *
 * The tool now parses + validates the SIE file when it STAGES (not only at
 * commit), so the approver sees real content (company, fiscal year, voucher
 * count, balance) and a broken/unbalanced file is rejected before anyone
 * approves a blind byte count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const importSie = tools.find((t) => t.name === 'gnubok_import_sie')!

const VALID_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Import AB"',
  '#ORGNR 5566778899',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2081 "Aktiekapital"',
  '#KONTO 6110 "Kontorsmaterial"',
  '#IB 0 1930 50000.00',
  '#IB 0 2081 -50000.00',
  '#VER A 1 20240115 "Inköp"',
  '{',
  '#TRANS 6110 {} 1000.00',
  '#TRANS 1930 {} -1000.00',
  '}',
].join('\n')

// Same file but the verification does not balance (1000 vs -900).
const UNBALANCED_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Trasig AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 6110 "Kontorsmaterial"',
  '#VER A 1 20240115 "Obalanserad"',
  '{',
  '#TRANS 6110 {} 1000.00',
  '#TRANS 1930 {} -900.00',
  '}',
].join('\n')

const COVER_VALID_SIE = [
  { sourceAccount: '6110', sourceName: 'Kontorsmaterial', targetAccount: '6110', targetName: 'Kontorsmaterial', confidence: 1, matchType: 'exact', isOverride: false },
  { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: '1930', targetName: 'Företagskonto', confidence: 1, matchType: 'exact', isOverride: false },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_import_sie: stage-time validation', () => {
  it('stages a valid file with a parsed, content-rich preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-sie' }, error: null }) // pending_operations insert

    const result = (await importSie.execute(
      { file_content: VALID_SIE, filename: 'bok.se', mappings: COVER_VALID_SIE },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-sie')
    // Preview now carries real parsed content, not just a byte count.
    expect(result.preview.company_name).toBe('Import AB')
    expect(result.preview.voucher_count).toBe(1)
    expect(result.preview.account_count).toBe(3)
    expect(result.preview.fiscal_year).toMatchObject({ start: '2024-01-01', end: '2024-12-31' })
    expect(result.preview.opening_balance).toMatchObject({ total: 0, is_balanced: true })
    expect(result.preview.accounts_mapped).toMatchObject({ covered: 2, total: 2 })
    expect(result.preview.would_skip_all_vouchers).toBe(false)
  })

  it('rejects an unbalanced file at stage time (no blind staging)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      importSie.execute(
        { file_content: UNBALANCED_SIE, filename: 'trasig.se', mappings: COVER_VALID_SIE },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/ogiltig/i)
  })

  it('rejects required-field gaps before parsing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      importSie.execute(
        { filename: 'x.se', mappings: [] },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/file_content/)
  })

  // Lookma AB regression (support case 2026-05-28): staging with mappings=[]
  // committed a 0-entry 'completed' sie_imports row that then blocked retry.
  // The fix refuses to stage when the mappings can't cover the file.
  it('rejects when mappings is empty and the file has vouchers', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      importSie.execute(
        { file_content: VALID_SIE, filename: 'lookma.se', mappings: [] },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/täcker inga konton|skulle hoppas över/i)
  })

  it('rejects when mappings don\'t overlap the file\'s accounts', async () => {
    const { supabase } = createQueuedMockSupabase()
    const wrongMappings = [
      { sourceAccount: '9999', sourceName: 'Fantasi', targetAccount: '9999', targetName: 'Fantasi', confidence: 1, matchType: 'exact', isOverride: false },
    ]
    await expect(
      importSie.execute(
        { file_content: VALID_SIE, filename: 'wrong.se', mappings: wrongMappings },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/täcker inga konton/i)
  })

  it('rejects when targetAccount is null on every mapping (Lookma shape)', async () => {
    const { supabase } = createQueuedMockSupabase()
    // The original Lookma agent sent #KONTO rows formatted as mapping objects
    // but with no targetAccount resolved. Coverage check ignores those.
    const halfBakedMappings = [
      { sourceAccount: '6110', sourceName: 'Kontorsmaterial', targetAccount: null, targetName: '', confidence: 0, matchType: 'manual', isOverride: false },
      { sourceAccount: '1930', sourceName: 'Företagskonto', targetAccount: null, targetName: '', confidence: 0, matchType: 'manual', isOverride: false },
    ]
    await expect(
      importSie.execute(
        { file_content: VALID_SIE, filename: 'half.se', mappings: halfBakedMappings },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/täcker inga konton/i)
  })

  it('stages when partial overlap exists (1 of 2 accounts mapped)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-sie-partial' }, error: null })

    const partial = [
      { sourceAccount: '6110', sourceName: 'Kontorsmaterial', targetAccount: '6110', targetName: 'Kontorsmaterial', confidence: 1, matchType: 'exact', isOverride: false },
    ]
    const result = (await importSie.execute(
      { file_content: VALID_SIE, filename: 'bok.se', mappings: partial },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.accounts_mapped).toMatchObject({ covered: 1, total: 2 })
    expect(result.preview.would_skip_all_vouchers).toBe(false)
  })
})

describe('gnubok_import_sie: update_account_names staging', () => {
  // Captures the pending_operations insert payload so the staged params can
  // be asserted (createQueuedMockSupabase cannot inspect arguments).
  function buildCapturingSupabase() {
    const staged: Array<Record<string, unknown>> = []
    const supabase = {
      from: (table: string) => {
        if (table !== 'pending_operations') throw new Error(`Unexpected table: ${table}`)
        return {
          insert: (row: Record<string, unknown>) => {
            staged.push(row)
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'op-sie' }, error: null }),
              }),
            }
          },
        }
      },
    }
    return { supabase, staged }
  }

  it('defaults update_account_names to true in the staged params', async () => {
    const { supabase, staged } = buildCapturingSupabase()

    await importSie.execute(
      { file_content: VALID_SIE, filename: 'bok.se', mappings: COVER_VALID_SIE },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )

    expect(staged).toHaveLength(1)
    expect((staged[0].params as Record<string, unknown>).update_account_names).toBe(true)
  })

  it('stages update_account_names: false when the caller opts out', async () => {
    const { supabase, staged } = buildCapturingSupabase()

    await importSie.execute(
      {
        file_content: VALID_SIE,
        filename: 'bok.se',
        mappings: COVER_VALID_SIE,
        update_account_names: false,
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )

    expect((staged[0].params as Record<string, unknown>).update_account_names).toBe(false)
  })
})
