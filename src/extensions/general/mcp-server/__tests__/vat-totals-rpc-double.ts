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
