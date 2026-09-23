/**
 * The SIE opening-balance difference lands on the legal form's result-closing
 * account, never on a hard-coded 2099.
 *
 * Before this, every import booked the IB imbalance (usually the prior year's
 * result the source system never carried into equity) on 2099. That is the
 * aktiebolag answer: an enskild firma closes its result to 2010 and an ideell
 * förening to 2069 (carried to 2068 at the next year start), and neither
 * form's year-end ever looks at 2099. The `unallocated_result` branch books
 * the WHOLE imbalance, not a rounding öre, so a migrating förening got its
 * prior-year result parked on an account its bokslut never touches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createJournalEntry, replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import {
  buildSIEOpeningBalanceEntry,
  executeSIEImport,
  resyncNextPeriodOpeningBalance,
} from '../sie-import'
import { prepareSIEJob } from '../sie-job-preparation'
import { parseSIEFile } from '../sie-parser'
import type { SIEJob } from '../sie-job-contract'
import type { ParsedSIEFile, AccountMapping } from '../types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ob-entry-1' })),
  replaceOpeningBalanceEntry: vi.fn(async () => ({
    stornoEntryId: 'storno-1',
    newEntryId: 'ob-new-1',
    stornoVoucherNumber: 1,
  })),
}))

vi.mock('@/lib/reports/imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(async () => []),
}))

// One row per form: the DB value, the account the profile closes the result
// to, and the name the notice prints. Spelled out on purpose: this is what
// the ledger must show, not what the registry happens to say.
const FORMS = [
  { form: 'ideell_forening', closing: '2069', closingName: 'Årets resultat' },
  { form: 'enskild_firma', closing: '2010', closingName: 'Eget kapital' },
  { form: 'aktiebolag', closing: '2099', closingName: 'Årets resultat' },
] as const

// --- Table-routing supabase mock (same shape as sie-import-ib-series.test.ts) ---

type QueuedResult = { data?: unknown; error?: unknown; count?: number | null }

function buildRoutingSupabase(tableQueues: Record<string, QueuedResult[]>) {
  const queues = new Map<string, QueuedResult[]>(
    Object.entries(tableQueues).map(([k, v]) => [k, [...v]])
  )
  const reads: string[] = []

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
      reads.push(table)
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

  return { supabase: supabase as unknown as SupabaseClient, reads }
}

/** An IB set that is 1 000 kr out of balance at file level (unallocated result). */
function makeParsedFile(): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Formen',
      orgNumber: '8021234567',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2024-01-01', end: '2024-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '2010', name: 'Eget kapital' },
    ],
    openingBalances: [
      { yearIndex: 0, account: '1930', amount: 5000 },
      { yearIndex: 0, account: '2010', amount: -4000 },
    ],
    closingBalances: [],
    resultBalances: [],
    dimensions: [],
    dimensionValues: [],
    vouchers: [],
    issues: [],
    stats: {
      totalAccounts: 2,
      totalVouchers: 0,
      totalTransactionLines: 0,
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
  }
}

function makeMapping(source: string, target: string): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target,
    targetName: `Target ${target}`,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

function standardQueues(entityType: string | null): Record<string, QueuedResult[]> {
  return {
    companies: [{ data: entityType ? { entity_type: entityType } : null }],
    sie_imports: [
      { data: null }, // checkDuplicateImport: no duplicate
      {}, // cleanupStaleImportRecords delete
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: null }, // checkDuplicatePeriodImport: no duplicate
    ],
    chart_of_accounts: [
      {
        data: [
          { account_number: '1930', account_name: 'Företagskonto' },
          { account_number: '2010', account_name: 'Eget kapital' },
        ],
      },
    ],
    fiscal_periods: [
      { data: { id: 'fp-1' } }, // find existing fiscal period
      { data: { opening_balances_set: false, opening_balance_entry_id: null } }, // IB-block check
    ],
    journal_entries: [
      { count: 0 }, // companyHasPriorActivity: first-ever import
      { data: [] }, // orphan-IB guard: no surviving IB voucher
    ],
  }
}

const standardOptions = {
  filename: 'formen.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: true,
  importTransactions: false,
  updateAccountNames: false,
}

const standardMappings = [makeMapping('1930', '1930'), makeMapping('2010', '2010')]
const accountMap = new Map([['1930', '1930'], ['2010', '2010']])

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildSIEOpeningBalanceEntry: the difference account is an input', () => {
  it.each(FORMS)('books the adjustment on $closing for $form', ({ closing }) => {
    const input = buildSIEOpeningBalanceEntry('fp-1', makeParsedFile(), accountMap, 1000, 'M', closing)
    expect(input).not.toBeNull()
    expect(input!.lines).toContainEqual(
      expect.objectContaining({ account_number: closing, debit_amount: 0, credit_amount: 1000 })
    )
    expect(input!.lines.some((l) => l.account_number === '2099' && closing !== '2099')).toBe(false)
  })
})

describe('executeSIEImport: IB difference follows the legal form', () => {
  it.each(FORMS)(
    'books the unallocated result on $closing and says so for $form',
    async ({ form, closing, closingName }) => {
      const { supabase, reads } = buildRoutingSupabase(standardQueues(form))

      const result = await executeSIEImport(
        supabase, 'company-1', 'user-1', makeParsedFile(), standardMappings, standardOptions,
      )

      expect(result.errors).toEqual([])
      expect(result.success).toBe(true)
      expect(createJournalEntry).toHaveBeenCalledTimes(1)
      const input = vi.mocked(createJournalEntry).mock.calls[0][3]
      expect(input.source_type).toBe('opening_balance')
      // Mapped diff is +1 000 (debit 5 000, credit 4 000): the adjustment credits the form's
      // account. (An EF file legitimately carries its own 2010 IB line next to it.)
      expect(input.lines).toContainEqual(
        expect.objectContaining({ account_number: closing, debit_amount: 0, credit_amount: 1000 })
      )
      expect(input.lines.some((l) => l.account_number === '2099' && closing !== '2099')).toBe(false)

      // The warning, the structured notice and the documentation name the same account.
      expect(result.warnings.some((w) => w.includes(`konto ${closing} (${closingName})`))).toBe(true)
      const notice = result.notices!.find((n) => n.code === 'sie_ib_unbalanced')
      expect(notice?.params?.account).toBe(closing)
      expect(result.details?.openingBalance).toEqual({
        imbalance: 1000,
        explanation: 'unallocated_result',
        bookedToAccount: closing,
      })

      // The form is read once per import, from companies.entity_type.
      expect(reads.filter((t) => t === 'companies')).toHaveLength(1)
    },
  )

  it('never defaults the form: an unresolvable entity_type fails the import before any IB voucher', async () => {
    const { supabase } = buildRoutingSupabase(standardQueues(null))

    const result = await executeSIEImport(
      supabase, 'company-1', 'user-1', makeParsedFile(), standardMappings, standardOptions,
    )

    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/entity_type/)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

describe('resyncNextPeriodOpeningBalance: IB difference follows the legal form', () => {
  it('books the resync difference on the account it is given', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31',
          is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
        },
      },
      { data: { voucher_series: 'M' } },
    ])
    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 5000 },
        { yearIndex: 0, account: '2010', amount: -4000 },
      ],
    } as unknown as ParsedSIEFile

    const resync = await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2024-12-31', parsed, accountMap, '2069',
    )

    expect(resync.resynced).toBe(true)
    const replacement = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4]
    expect(replacement.lines).toContainEqual(
      expect.objectContaining({ account_number: '2069', debit_amount: 0, credit_amount: 1000 })
    )
    expect(replacement.lines.some((l) => l.account_number === '2099')).toBe(false)
  })
})

describe('prepareSIEJob (durable import): IB difference follows the legal form', () => {
  it('seals the förening account in the manifest and books the IB difference on it', async () => {
    const source = '#RAR 0 20260101 20261231\n#IB 0 1930 5000\n#IB 0 2010 -4000'
    const parsed = parseSIEFile(source)
    const fileHash = createHash('sha256').update(source).digest('hex')
    const options = {
      filename: 'formen.si', createFiscalPeriod: false, importOpeningBalances: true, importTransactions: false,
    }
    const job = {
      id: 'import-1', company_id: 'company-1', user_id: 'user-1', fiscal_period_id: 'fp-1',
      file_hash: fileHash, file_storage_path: `company-1/sie-jobs/${fileHash}.se`, prepared_through: 0,
      manifest: {
        input: { version: 1, sourceHash: fileHash, mappings: standardMappings, options },
        snapshotComplete: true, metadataComplete: true,
        effectiveOpeningBalances: parsed.openingBalances, derivedFromPriorYearUB: false,
        preparationTotals: {
          entries: 0, movements: [], skippedSample: [],
          skippedCounts: { empty: 0, unbalanced: 0, unmapped: 0, singleLine: 0, total: 0 },
        },
      },
    } as unknown as SIEJob
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { payload: [{ parsed: { ...parsed, vouchers: [] }, voucherGroups: 0, metadataGroups: 0,
        hasCurrentYearIb: true, sourceSeries: [], openingBalanceVoucherCandidate: false }] } },
      { data: [] }, // metadata groups
      { data: [] }, // chart account ids
      { data: { entity_type: 'ideell_forening' } }, // companies.entity_type
    ])

    await expect(prepareSIEJob(supabase as unknown as SupabaseClient, job, Infinity)).resolves.toBe(true)

    const rpcCalls = supabase.rpc.mock.calls as [string, Record<string, unknown>][]
    const finalize = rpcCalls.find(([name, args]) => name === 'save_sie_import_chunk' && args.p_phase === 'finalize')
    expect(finalize).toBeDefined()
    const [entry] = finalize![1].p_payload as Array<{ lines: Array<{ account_number: string; credit_amount: number }> }>
    expect(entry.lines).toContainEqual(expect.objectContaining({ account_number: '2069', credit_amount: 1000 }))
    expect(entry.lines.some((l) => l.account_number === '2099')).toBe(false)

    const seal = rpcCalls.find(([name]) => name === 'seal_sie_import_preparation')
    expect(seal![1].p_manifest).toMatchObject({
      openingBalanceRounding: 1000,
      openingBalanceDifferenceAccount: '2069',
    })
  })
})
