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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_import_sie — stage-time validation', () => {
  it('stages a valid file with a parsed, content-rich preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-sie' }, error: null }) // pending_operations insert

    const result = (await importSie.execute(
      { file_content: VALID_SIE, filename: 'bok.se', mappings: [] },
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
  })

  it('rejects an unbalanced file at stage time (no blind staging)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      importSie.execute(
        { file_content: UNBALANCED_SIE, filename: 'trasig.se', mappings: [] },
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
})
