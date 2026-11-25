import { getPool, withUserContext } from './setup'
import { voucherDisplayAmount } from '@/lib/bookkeeping/voucher-display-amount'

/**
 * The judge of the verifikat list's Belopp sorts, outside their SQL: the
 * amount each verifikat shows, from the TypeScript helper the list renders
 * the Belopp column with (voucherDisplayAmount), and the order a page of
 * ids must come in when sorted by it with the list's other keys.
 */

/** Every verifikat's shown amount for a company, read as its member the way the list reads it. */
export async function shownAmounts(userId: string, companyId: string): Promise<Map<string, number>> {
  return withUserContext(userId, async (client) => {
    const { rows: entries } = await client.query<{
      id: string
      source_type: string
      lines: Array<{ account_number: string; debit_amount: string | null; credit_amount: string | null }>
    }>(
      `SELECT je.id, je.source_type,
              coalesce(json_agg(json_build_object(
                'account_number', l.account_number,
                'debit_amount', l.debit_amount,
                'credit_amount', l.credit_amount)) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM public.journal_entries je
         LEFT JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.company_id = $1
        GROUP BY je.id, je.source_type`,
      [companyId],
    )
    const { rows: cash } = await client.query<{ ledger_account: string }>(
      `SELECT ledger_account FROM public.cash_accounts
        WHERE company_id = $1 AND ledger_account IS NOT NULL`,
      [companyId],
    )
    const moneyLedgers = new Set(cash.map((c) => c.ledger_account))
    return new Map(entries.map((e) => [e.id, voucherDisplayAmount(e, moneyLedgers).amount]))
  })
}

// The list RPCs' order tokens over the verifikat and its shown amount.
const COLUMN: Record<string, string> = {
  entry_date: 'je.entry_date',
  voucher_series: 'je.voucher_series',
  voucher_number: 'je.voucher_number',
  description: 'je.description',
  display_amount: 'x.amount',
  id: 'je.id',
}

/**
 * The ids in the order `ORDER BY <tokens>, id` gives them, with the amount
 * each one shows: what a list RPC's pages, read one after the other, must
 * add up to. Postgres orders them, so text sorts by the database's collation
 * as the RPC's does.
 */
export async function orderByShownAmount(
  ids: readonly string[],
  amounts: ReadonlyMap<string, number>,
  tokens: readonly string[],
): Promise<string[]> {
  const orderBy = [...tokens, 'id.asc']
    .map((token) => {
      const [column, direction] = token.split('.')
      if (!COLUMN[column] || (direction !== 'asc' && direction !== 'desc')) throw new Error(`unknown order token ${token}`)
      return `${COLUMN[column]} ${direction.toUpperCase()}`
    })
    .join(', ')
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT je.id
       FROM unnest($1::uuid[], $2::numeric[]) AS x(id, amount)
       JOIN public.journal_entries je ON je.id = x.id
      ORDER BY ${orderBy}`,
    [ids, ids.map((id) => {
      const amount = amounts.get(id)
      if (amount === undefined) throw new Error(`no shown amount for ${id}`)
      return amount
    })],
  )
  return rows.map((r) => r.id)
}
