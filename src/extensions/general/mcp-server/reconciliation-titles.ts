/**
 * The titles of the staged reconciliation operations, as a person reads them
 * in the approval queue (crm#1938).
 *
 * An account_key ("bank:<cash account id>", "manual:<BAS>", "skattekonto") is
 * how the tools address an account. The titles were built from it, so the
 * queue read "Markera bank:3f2a... som avstämt" and two accounts at the same
 * bank could not be told apart without opening each proposal. A title names
 * the account the way the Avstämning page lists it (its name and its BAS
 * account), an outside row by its date and text, and a residual by what it
 * is. No key, id or code of ours belongs in a title.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'
import { RESIDUAL_KINDS, type ResidualKind } from '@/lib/reconciliation/residual'
import { parseAccountKey } from '@/lib/reconciliation/schemas'
import { resolveSkattekontoAccount } from '@/lib/skatteverket/skattekonto-account'

const log = createLogger('mcp-server:reconciliation-titles')

/** What the account is called when its name cannot be read: never the key. */
const UNNAMED: Record<'bank' | 'skattekonto' | 'manual', string> = {
  bank: 'bankkontot',
  skattekonto: 'Skattekonto',
  manual: 'kontot',
}

/**
 * "Företagskonto (1930)", "Skattekonto (1630)", "Kundfordringar (1510)": the
 * account behind an account_key. A read that fails costs the name, never the
 * staging: the title then says "bankkontot" or the BAS account alone.
 */
export async function accountKeyLabel(supabase: SupabaseClient, companyId: string, accountKey: string): Promise<string> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return UNNAMED.manual
  try {
    if (parsed.kind === 'skattekonto') {
      return `Skattekonto (${await resolveSkattekontoAccount(supabase, companyId)})`
    }
    if (parsed.kind === 'bank') {
      const { data } = await supabase
        .from('cash_accounts')
        .select('name, ledger_account')
        .eq('company_id', companyId)
        .eq('id', parsed.cashAccountId)
        .maybeSingle<{ name: string | null; ledger_account: string | null }>()
      if (!data?.ledger_account) return UNNAMED.bank
      const name = data.name?.trim()
      // The Avstämning list's own fallback for an account without a name.
      return name ? `${name} (${data.ledger_account})` : `Bankkonto ${data.ledger_account}`
    }
    const { data } = await supabase
      .from('chart_of_accounts')
      .select('account_name')
      .eq('company_id', companyId)
      .eq('account_number', parsed.accountNumber)
      .maybeSingle<{ account_name: string | null }>()
    const name = data?.account_name?.trim()
    return name ? `${name} (${parsed.accountNumber})` : `Konto ${parsed.accountNumber}`
  } catch (err) {
    log.warn('account label read failed; the title names the account without it', {
      companyId,
      kind: parsed.kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return parsed.kind === 'manual' ? `Konto ${parsed.accountNumber}` : UNNAMED[parsed.kind]
  }
}

/**
 * "2026-10-03 Hyra kontor": one outside row (a bank transaction or a
 * skattekonto row) by its date and text. Null when it cannot be read; the
 * title then says "en rad".
 */
export async function outsideRowLabel(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  rowId: string,
): Promise<string | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual' || !isUuid(rowId)) return null
  try {
    if (parsed.kind === 'bank') {
      const { data } = await supabase
        .from('transactions')
        .select('date, description, merchant_name')
        .eq('company_id', companyId)
        .eq('id', rowId)
        .maybeSingle<{ date: string | null; description: string | null; merchant_name: string | null }>()
      return data ? [data.date, data.description || data.merchant_name].filter(Boolean).join(' ') || null : null
    }
    const { data } = await supabase
      .from('skattekonto_transactions')
      .select('transaktionsdatum, transaktionstext')
      .eq('company_id', companyId)
      .eq('id', rowId)
      .maybeSingle<{ transaktionsdatum: string | null; transaktionstext: string | null }>()
    return data ? [data.transaktionsdatum, data.transaktionstext].filter(Boolean).join(' ') || null : null
  } catch (err) {
    log.warn('outside row read failed; the title names no row', {
      companyId,
      kind: parsed.kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

const rowCount = (count: number) => `${count} ${count === 1 ? 'rad' : 'rader'}`

/** `settledEntryCount`: the verifikat settled against each other when every pair is such a settlement, else null. */
export function reconciliationMatchTitle(account: string, pairCount: number, settledEntryCount: number | null): string {
  return settledEntryCount !== null
    ? `Koppla ${settledEntryCount} verifikat mot varandra på ${account}`
    : `Koppla ${rowCount(pairCount)} på ${account}`
}

/** `row`: the outside row's label, null when it could not be read; 'settlement' for verifikat settled against each other. */
export function reconciliationUnmatchTitle(account: string, row: string | null | 'settlement'): string {
  if (row === 'settlement') return `Koppla bort verifikat som kopplats mot varandra på ${account}`
  return row ? `Koppla bort rad på ${account}: ${row}` : `Koppla bort en rad på ${account}`
}

export function reconciliationSignoffTitle(account: string, throughDate: string): string {
  return `Markera ${account} som avstämt t.o.m. ${throughDate}`
}

export function reconciliationResidualTitle(
  account: string,
  residual: { amount: number; currency: string; kind: ResidualKind; rows: number },
): string {
  const what = RESIDUAL_KINDS[residual.kind]?.label_sv.toLowerCase() ?? 'restpost'
  return `Bokför restpost ${residual.amount} ${residual.currency} (${what}) på ${account} och koppla ${rowCount(residual.rows)}`
}
