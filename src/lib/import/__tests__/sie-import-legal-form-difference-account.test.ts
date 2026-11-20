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
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildSIEOpeningBalanceEntry } from '../sie-import'
import { prepareSIEJob } from '../sie-job-preparation'
import { parseSIEFile } from '../sie-parser'
import type { SIEJob } from '../sie-job-contract'
import type { ParsedSIEFile, AccountMapping } from '../types'

// One row per form: the DB value and the account the profile closes the
// result to. Spelled out on purpose: this is what the ledger must show, not
// what the registry happens to say.
const FORMS = [
  { form: 'ideell_forening', closing: '2069' },
  { form: 'enskild_firma', closing: '2010' },
  { form: 'aktiebolag', closing: '2099' },
] as const

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

const standardMappings = [makeMapping('1930', '1930'), makeMapping('2010', '2010')]
const accountMap = new Map([['1930', '1930'], ['2010', '2010']])

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
