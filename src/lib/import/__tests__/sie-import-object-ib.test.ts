/**
 * Issue #3313, direct import path: executeSIEImport books the IB split per
 * project from the file's #OIB 0 rows, reading the company's accumulating
 * dimensions after it registered the file's dimensions. When the registry
 * refuses a tag (an archived project in a company with dimensions on), the
 * IB is booked untagged with a notice instead of failing an import that
 * ignored #OIB until now.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSIEImport } from '../sie-import'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { DimensionValidationError } from '@/lib/bookkeeping/dimension-errors'
import { parseSIEFile } from '../sie-parser'
import type { AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ob-entry-1' })),
  replaceOpeningBalanceEntry: vi.fn(),
}))

vi.mock('@/lib/reports/imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(async () => []),
}))

// --- Helpers ---

type QueuedResult = { data?: unknown; error?: unknown; count?: number | null }

/**
 * Table-routing supabase mock: each table has its own FIFO of results
 * (consumed per .from(table) call), falling back to { data: null, error:
 * null } when the queue is empty. Order-independent across tables, so the
 * mock doesn't break when an unrelated query is added elsewhere in the flow.
 */
function buildRoutingSupabase(tableQueues: Record<string, QueuedResult[]>) {
  const queues = new Map<string, QueuedResult[]>(
    Object.entries(tableQueues).map(([k, v]) => [k, [...v]])
  )

  const makeChain = (result: { data: unknown; error: unknown; count: number | null }): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (..._args: unknown[]) => makeChain(result)
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: (table: string) => {
      const next = queues.get(table)?.shift() ?? {}
      return makeChain({
        data: next.data ?? null,
        error: next.error ?? null,
        count: next.count ?? null,
      })
    },
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  }

  return supabase as unknown as SupabaseClient
}

function mapping(account: string): AccountMapping {
  return {
    sourceAccount: account,
    sourceName: `Account ${account}`,
    targetAccount: account,
    targetName: `Account ${account}`,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

const FILE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Projekt AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1470 "Pågående arbeten"',
  '#KONTO 2081 "Aktiekapital"',
  '#DIM 6 "Projekt"',
  '#OBJEKT 6 "P1" "Villa"',
  '#IB 0 1470 5000.00',
  '#IB 0 2081 -5000.00',
  '#OIB 0 1470 {6 "P1"} 1200.00',
].join('\n')

function queues(): Record<string, QueuedResult[]> {
  return {
    companies: [{ data: { entity_type: 'aktiebolag' } }],
    sie_imports: [
      { data: null }, // checkDuplicateImport
      {}, // cleanupStaleImportRecords
      { data: { id: 'imp-1' } }, // createPendingImportRecord
      { data: null }, // checkDuplicatePeriodImport
    ],
    dimensions: [
      { data: [] }, // importDimensionRegistry: upsert (all pre-existing)
      { data: [{ id: 'dim-6', sie_dim_no: 6 }] }, // registry ids for the values
      { data: [{ sie_dim_no: 6 }] }, // accumulating dimensions for the IB split
    ],
    dimension_values: [{ data: [] }],
    company_settings: [{ data: { dimensions_enabled: true } }],
    chart_of_accounts: [
      {
        data: [
          { account_number: '1470', account_name: 'Pågående arbeten' },
          { account_number: '2081', account_name: 'Aktiekapital' },
        ],
      },
    ],
    fiscal_periods: [
      { data: { id: 'fp-1' } },
      { data: { opening_balances_set: false, opening_balance_entry_id: null } },
    ],
    journal_entries: [{ count: 0 }],
  }
}

const OPTIONS = {
  filename: 'projekt.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: false,
}

function netByBag(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    const key = `${line.account_number}${line.dimensions ? ' ' + JSON.stringify(line.dimensions) : ''}`
    out[key] = Math.round(((out[key] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

describe('executeSIEImport: IB split per project from #OIB (issue #3313)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('books the object part tagged and the remainder untagged on the IB verifikat', async () => {
    const result = await executeSIEImport(
      buildRoutingSupabase(queues()),
      'company-1',
      'user-1',
      parseSIEFile(FILE),
      [mapping('1470'), mapping('2081')],
      OPTIONS,
    )

    expect(result.errors).toEqual([])
    expect(result.openingBalanceEntryId).toBe('ob-entry-1')
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.source_type).toBe('opening_balance')
    expect(netByBag(input.lines)).toEqual({ '1470 {"6":"P1"}': 1200, '1470': 3800, '2081': -5000 })
  })

  it('books the IB untagged, with a notice, when the registry refuses a project tag', async () => {
    vi.mocked(createJournalEntry)
      .mockRejectedValueOnce(
        new DimensionValidationError([{ sie_dim_no: '6', code: 'P1', reason: 'archived_value', dimension_name: 'Projekt' }])
      )
      .mockResolvedValueOnce({ id: 'ob-entry-2' } as never)

    const result = await executeSIEImport(
      buildRoutingSupabase(queues()),
      'company-1',
      'user-1',
      parseSIEFile(FILE),
      [mapping('1470'), mapping('2081')],
      OPTIONS,
    )

    expect(result.errors).toEqual([])
    expect(result.openingBalanceEntryId).toBe('ob-entry-2')
    expect(createJournalEntry).toHaveBeenCalledTimes(2)
    const retry = vi.mocked(createJournalEntry).mock.calls[1][3]
    expect(netByBag(retry.lines)).toEqual({ '1470': 5000, '2081': -5000 })
    expect(result.warnings.join(' ')).toMatch(/utan fördelning per projekt/)
    // A structured sv/en notice, not a legacy string.
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'sie_ib_project_split_refused', severity: 'notice' })
    )
    expect(result.notices?.some((n) => n.code === 'legacy' && /fördelning per projekt/.test(String(n.params?.text)))).toBe(false)
  })
})
