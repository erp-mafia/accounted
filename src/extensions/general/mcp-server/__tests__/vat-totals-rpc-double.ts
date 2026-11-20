/**
 * Test double for the get_vat_declaration_totals RPC, shared by the MCP VAT
 * report and close-check tests.
 *
 * Like seedLedger in lib/reports/__tests__/vat-declaration.test.ts it only
 * SUMS the fixture lines per account, as the SQL's GROUP BY returns them, and
 * only for the accounts the caller passed in p_accounts, so a report that
 * forgets to ask for an account sees it as empty, exactly as against Postgres.
 * Which entries the RPC leaves out (the posted bokslutsverifikat, kontantmetod
 * vändningar, momsredovisningar) is the SQL's decision and is covered against
 * real Postgres in tests/pg/vat-declaration-totals-rpc.pg.test.ts,
 * tests/pg/vat-totals-closing-entry.pg.test.ts and
 * tests/pg/vat-skattekonto-counter-entries.pg.test.ts. A fixture states that
 * decision explicitly through `excludedEntryIds` and `settlementShapedEntries`.
 */
import type { VatSettlementShapedEntry } from '@/lib/reports/vat-declaration'

export interface VatTotalsFixtureLine {
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
}

export interface VatTotalsFixture {
  lines: VatTotalsFixtureLine[]
  /** Entries the RPC leaves out of the totals (closing entry, settlements). */
  excludedEntryIds?: Iterable<string>
  /** What the RPC lists as momsredovisning by shape. */
  settlementShapedEntries?: VatSettlementShapedEntry[]
}

export function vatTotalsRpcResult(
  fixture: VatTotalsFixture,
  params: { p_accounts?: string[] } | undefined,
): { data: unknown; error: null } {
  const accounts = new Set(params?.p_accounts ?? [])
  const excluded = new Set(fixture.excludedEntryIds ?? [])
  const byAccount = new Map<string, { debit: number; credit: number }>()
  for (const line of fixture.lines) {
    if (excluded.has(line.journal_entry_id)) continue
    if (!accounts.has(line.account_number)) continue
    const t = byAccount.get(line.account_number) ?? { debit: 0, credit: 0 }
    t.debit += line.debit_amount
    t.credit += line.credit_amount
    byAccount.set(line.account_number, t)
  }
  return {
    data: {
      totals: [...byAccount].map(([account_number, t]) => ({
        account_number,
        debit: t.debit,
        credit: t.credit,
      })),
      settlement_shaped_entries: fixture.settlementShapedEntries ?? [],
      source_type_counts: {},
    },
    error: null,
  }
}

/**
 * Test double for get_entries_with_account_lines (the reverse-charge basis
 * scan, the periodisk sammanställning): the fixture's entries with a line on
 * p_accounts and a status in p_statuses, ordered by id, each with its lines on
 * p_accounts or, with p_all_lines, every line, ordered by account and id. The
 * period and the days it reads are the SQL's business, covered against real
 * Postgres in tests/pg/entries-with-account-lines.pg.test.ts.
 */
export function entriesWithAccountLinesRpcResult(
  entries: Array<{ id: string; status: string }>,
  lines: Array<VatTotalsFixtureLine & { id: string }>,
  params: { p_accounts?: string[]; p_statuses?: string[]; p_all_lines?: boolean } | undefined,
): { data: unknown; error: null } {
  const accounts = new Set(params?.p_accounts ?? [])
  const statuses = new Set(params?.p_statuses ?? [])
  const rows = entries
    .filter((entry) => statuses.has(entry.status))
    .filter((entry) => lines.some((l) => l.journal_entry_id === entry.id && accounts.has(l.account_number)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => ({
      ...entry,
      lines: lines
        .filter((l) => l.journal_entry_id === entry.id && (params?.p_all_lines || accounts.has(l.account_number)))
        .sort((a, b) => a.account_number.localeCompare(b.account_number) || (a.id < b.id ? -1 : 1))
        .map(({ id, account_number, debit_amount, credit_amount }) => ({ id, account_number, debit_amount, credit_amount })),
    }))
  return { data: rows, error: null }
}
