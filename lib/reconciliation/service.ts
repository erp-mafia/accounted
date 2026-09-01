import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { getReconciliationStatus as getBankReconciliationStatus } from './bank-reconciliation'
import { getSkattekontoReconciliationStatus } from './skattekonto-reconciliation'
import {
  bankAccountKey,
  parseAccountKey,
  SKATTEKONTO_ACCOUNT_KEY,
  STALE_AFTER_DAYS,
  type BridgeLine,
  type ReconciliationAccount,
  type ReconciliationStatus,
} from './schemas'
import { getLatestSignoff, getLatestSignoffs } from './signoff-store'
import { bankLogoUrl } from './bank-logos'
import { getManualReconciliationStatus, listManualAccounts } from './manual-reconciliation'

const log = createLogger('reconciliation/service')

/**
 * The account-keyed reconciliation facade: one engine, three doors.
 *
 * The dashboard routes, the public v1 API and the MCP tools all call these
 * functions; none of them re-implements bank or skattekonto logic. Kind
 * adapters (bank via bank-reconciliation.ts, skattekonto via
 * skattekonto-reconciliation.ts, every other balance account via
 * manual-reconciliation.ts) hang off `account_key`, so adding an account
 * type is one adapter, never a new set of endpoints.
 *
 * Core runs with zero extensions: the skattekonto adapter reads the core
 * `skattekonto_transactions` table and the snapshot row the extension leaves
 * in `extension_data`, and simply reports "not configured" when neither
 * exists.
 */

export interface ListAccountsOptions {
  today?: string
  /** Compute status per account (N reads). Default true; the rail needs it. */
  withStatus?: boolean
  /** Window for the bank bridge ("i perioden"). Defaults to the calendar year of `today`. */
  windowFrom?: string
  windowTo?: string
}

interface CashAccountRow {
  id: string
  name: string | null
  ledger_account: string
  currency: string | null
  iban: string | null
  enabled: boolean | null
  is_primary: boolean | null
  source: string | null
  bank_connection_id: string | null
  balance: number | null
  available_balance: number | null
  balance_updated_at: string | null
  updated_at: string | null
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()
  return Math.round(ms / 86_400_000)
}

function defaultWindow(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 4)}-01-01`, to: today }
}

async function latestBankSyncAt(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('transactions')
    .select('created_at')
    .eq('company_id', companyId)
    .eq('cash_account_id', cashAccountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.created_at as string | undefined) ?? null
}

/** Bridge lines for the bank kind, mirroring the #1737 status card. */
function bankBridge(status: Awaited<ReturnType<typeof getBankReconciliationStatus>>, accountNumber: string): BridgeLine[] {
  const lines: BridgeLine[] = [
    {
      key: 'bank_transactions',
      label_sv: 'Rörelse på banken i perioden',
      label_en: 'Movement on the bank in the period',
      amount: status.bank_transaction_total,
      count: null,
      items_bucket: null,
    },
    {
      key: 'unmatched_external',
      label_sv: 'Omatchade banktransaktioner',
      label_en: 'Unmatched bank transactions',
      amount: roundOre(-status.unmatched_transaction_total),
      count: status.unmatched_transaction_count,
      items_bucket: 'unmatched_external',
    },
  ]
  if (status.unmatched_gl_line_total !== null) {
    lines.push({
      key: 'unmatched_ledger',
      label_sv: `Verifikationer på ${accountNumber} utan banktransaktion`,
      label_en: `Vouchers on ${accountNumber} without a bank transaction`,
      amount: status.unmatched_gl_line_total,
      count: status.unmatched_gl_line_count,
      items_bucket: 'unmatched_ledger',
    })
  }
  if (status.ignored_transaction_count > 0) {
    lines.push({
      key: 'ignored',
      label_sv: 'Ignorerade transaktioner',
      label_en: 'Ignored transactions',
      amount: status.ignored_transaction_total,
      count: status.ignored_transaction_count,
      items_bucket: 'ignored',
    })
  }
  lines.push({
    key: 'ledger_balance',
    label_sv: `Bokfört på ${accountNumber} i perioden`,
    label_en: `Booked on ${accountNumber} in the period`,
    amount: status.gl_1930_period_movement,
    count: null,
    items_bucket: null,
  })
  return lines
}

async function bankStatus(
  supabase: SupabaseClient,
  companyId: string,
  account: CashAccountRow,
  window: { from: string; to: string },
  today: string,
): Promise<ReconciliationStatus> {
  const currency = account.currency ?? 'SEK'
  const raw = await getBankReconciliationStatus(
    supabase,
    companyId,
    window.from,
    window.to,
    account.ledger_account,
    currency,
    account.id,
    Boolean(account.is_primary),
  )
  const syncedAt = await latestBankSyncAt(supabase, companyId, account.id)
  const stale = !syncedAt || daysBetween(today, syncedAt.slice(0, 10)) > STALE_AFTER_DAYS
  // The bank-reported (booked) balance, mirrored from the last PSD2 balance
  // refresh. Point-in-time and dated by balance_updated_at, NOT by any
  // through-date a caller asks for. It therefore lives ONLY in the bank block
  // below, never in external_balance: sign-off persists external_balance into
  // account_reconciliations and bokslutsbilagor computes closing - external
  // from that row, so a today-balance stored on a balansdag sign-off would
  // print a phantom differens in the year-end appendix (skeptic finding,
  // PR #2118). difference/unexplained stay transaction-based for the same
  // reason. A balance without its timestamp is unusable (age unknown), so
  // both fields are exposed only as a pair.
  const reportedBalance =
    account.balance == null || account.balance_updated_at == null
      ? null
      : Number(account.balance)
  const reportedAvailable =
    reportedBalance == null || account.available_balance == null
      ? null
      : Number(account.available_balance)
  return {
    account_key: bankAccountKey(account.id),
    kind: 'bank',
    account_number: account.ledger_account,
    currency,
    window: { from: window.from, to: window.to },
    as_of: new Date().toISOString(),
    stale,
    external_balance: null,
    ledger_balance: raw.gl_1930_period_movement,
    difference: raw.difference,
    unexplained_difference: raw.unexplained_difference,
    is_reconciled: raw.is_reconciled,
    bridge: bankBridge(raw, account.ledger_account),
    counts: {
      proposed: 0,
      unmatched_external: raw.unmatched_transaction_count,
      unmatched_ledger: raw.unmatched_gl_line_count,
      matched: raw.matched_count,
      ignored: raw.ignored_transaction_count,
    },
    skattekonto: null,
    bank: {
      ...(raw as unknown as Record<string, unknown>),
      // What the bank itself reports for the account (F7): booked +
      // available + when it was fetched. Distinct from the movement fields.
      bank_reported_balance: reportedBalance,
      bank_reported_available_balance: reportedAvailable,
      bank_balance_updated_at: reportedBalance == null ? null : account.balance_updated_at,
    },
  }
}

function stateOf(status: ReconciliationStatus | null): ReconciliationAccount['status'] {
  if (!status) return null
  const state = status.is_reconciled
    ? 'reconciled'
    : status.stale
      ? 'stale'
      : 'open'
  return {
    state,
    as_of: status.as_of,
    unexplained_difference: status.unexplained_difference,
    open_counts: {
      proposed: status.counts.proposed,
      unmatched_external: status.counts.unmatched_external,
      unmatched_ledger: status.counts.unmatched_ledger,
    },
  }
}

/**
 * Every account with an outside truth, as the side list shows them: enabled
 * cash accounts (deduplicated per IBAN + currency, the reconnect-duplicate
 * case measured at 25 rows in 17 companies) plus the skattekonto when the
 * company has a saldo snapshot or rows.
 */
export async function listReconciliationAccounts(
  supabase: SupabaseClient,
  companyId: string,
  options: ListAccountsOptions = {},
): Promise<ReconciliationAccount[]> {
  const today = options.today ?? isoDate(new Date())
  const withStatus = options.withStatus ?? true
  const window = {
    from: options.windowFrom ?? defaultWindow(today).from,
    to: options.windowTo ?? defaultWindow(today).to,
  }

  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, name, ledger_account, currency, iban, enabled, is_primary, source, bank_connection_id, balance, available_balance, balance_updated_at, updated_at')
    .eq('company_id', companyId)
    .eq('enabled', true)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })
  if (error) throw new Error(`Kunde inte hämta kassakonton: ${error.message}`)
  const cashAccounts = (data ?? []) as CashAccountRow[]

  // Reconnect duplicates: same IBAN and currency twice. Keep the most recently
  // updated row as the live one and mark the other as superseded so a rail
  // can fold it away; never drop it silently, it may still hold unlinked rows.
  const supersededBy = new Map<string, string>()
  const byIban = new Map<string, CashAccountRow[]>()
  for (const a of cashAccounts) {
    if (!a.iban) continue
    const k = `${a.iban}|${a.currency ?? 'SEK'}`
    byIban.set(k, [...(byIban.get(k) ?? []), a])
  }
  for (const group of byIban.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((x, y) => (y.updated_at ?? '').localeCompare(x.updated_at ?? ''))
    const keep = sorted[0]
    for (const other of sorted.slice(1)) supersededBy.set(other.id, bankAccountKey(keep.id))
  }

  // Latest active sign-off per account, one query; the rail shows "avstämt
  // t.o.m." next to the live status. A failed read must not hide the accounts.
  let signoffs = new Map<string, Awaited<ReturnType<typeof getLatestSignoff>>>()
  try {
    signoffs = await getLatestSignoffs(supabase, companyId)
  } catch (err) {
    log.warn('sign-off read failed', { companyId, error: err instanceof Error ? err.message : String(err) })
  }

  // Bank logos resolve from the connection's bank_name (the same name the
  // connect flow shows). A failed read only costs the logos.
  const bankNameByConnection = new Map<string, string>()
  const connectionIds = [...new Set(cashAccounts.map((a) => a.bank_connection_id).filter((x): x is string => !!x))]
  if (connectionIds.length > 0) {
    const { data: connRows, error: connError } = await supabase
      .from('bank_connections')
      .select('id, bank_name')
      .in('id', connectionIds)
    if (connError) {
      log.warn('bank_name read failed; monograms instead of logos', { companyId, error: connError.message })
    }
    for (const r of (connRows ?? []) as Array<{ id: string; bank_name: string | null }>) {
      if (r.bank_name) bankNameByConnection.set(r.id, r.bank_name)
    }
  }

  const bankAccounts = await Promise.all(
    cashAccounts.map(async (a): Promise<ReconciliationAccount> => {
      let status: ReconciliationStatus | null = null
      let syncedAt: string | null = null
      if (withStatus) {
        try {
          status = await bankStatus(supabase, companyId, a, window, today)
        } catch (err) {
          log.warn('bank status failed for account', {
            companyId,
            cashAccountId: a.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      try {
        syncedAt = await latestBankSyncAt(supabase, companyId, a.id)
      } catch {
        syncedAt = null
      }
      const stale = !syncedAt || daysBetween(today, syncedAt.slice(0, 10)) > STALE_AFTER_DAYS
      return {
        account_key: bankAccountKey(a.id),
        kind: 'bank',
        account_number: a.ledger_account,
        name: a.name ?? `Bankkonto ${a.ledger_account}`,
        currency: a.currency ?? 'SEK',
        logo_url: bankLogoUrl(a.bank_connection_id ? bankNameByConnection.get(a.bank_connection_id) : null, a.name),
        source: {
          type: a.bank_connection_id ? 'psd2' : a.source === 'file' ? 'bank_file' : 'manual',
          synced_at: syncedAt,
          stale,
        },
        status: stateOf(status),
        superseded_by: supersededBy.get(a.id) ?? null,
        signed_off_through: signoffs.get(bankAccountKey(a.id))?.through_date ?? null,
      }
    }),
  )

  let skattekonto: ReconciliationAccount | null = null
  try {
    const s = await getSkattekontoReconciliationStatus(supabase, companyId, { today })
    if (s) {
      skattekonto = {
        account_key: SKATTEKONTO_ACCOUNT_KEY,
        kind: 'skattekonto',
        account_number: s.account_number,
        name: 'Skattekonto',
        currency: 'SEK',
        logo_url: '/logos/skatteverket_color.svg',
        source: {
          type: 'skatteverket_api',
          synced_at: s.skattekonto?.fetched_at ?? null,
          stale: s.stale,
        },
        status: s.skattekonto?.fetched_at ? stateOf(s) : { ...stateOf(s)!, state: 'not_configured' },
        superseded_by: null,
        signed_off_through: signoffs.get(SKATTEKONTO_ACCOUNT_KEY)?.through_date ?? null,
      }
    }
  } catch (err) {
    log.warn('skattekonto status failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // The rest of the balance sheet: every account the two feeds above do not
  // own, reconciled against a system specification or the signer's underlag.
  // A failed read costs only this group, never the bank or skattekonto rows.
  let manualAccounts: ReconciliationAccount[] = []
  try {
    const exclude = new Set<string>(cashAccounts.map((a) => a.ledger_account))
    if (skattekonto) exclude.add(skattekonto.account_number)
    manualAccounts = await listManualAccounts(supabase, companyId, {
      asOf: window.to,
      exclude,
      signoffs,
      withStatus,
    })
  } catch (err) {
    log.warn('manual accounts failed', { companyId, error: err instanceof Error ? err.message : String(err) })
  }

  return [...bankAccounts, ...(skattekonto ? [skattekonto] : []), ...manualAccounts]
}

export interface GetAccountStatusOptions {
  today?: string
  windowFrom?: string | null
  windowTo?: string | null
}

/**
 * The bridge for one account. Returns null when the key does not resolve to
 * an account of this company (callers map that to 404).
 */
export async function getAccountStatus(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  options: GetAccountStatusOptions = {},
): Promise<ReconciliationStatus | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  const today = options.today ?? isoDate(new Date())

  let status: ReconciliationStatus | null = null
  if (parsed.kind === 'skattekonto') {
    status = await getSkattekontoReconciliationStatus(supabase, companyId, {
      today,
      windowFrom: options.windowFrom ?? null,
      windowTo: options.windowTo ?? null,
    })
  }

  if (parsed.kind === 'bank') {
    const { data, error } = await supabase
      .from('cash_accounts')
      .select('id, name, ledger_account, currency, iban, enabled, is_primary, source, bank_connection_id, balance, available_balance, balance_updated_at, updated_at')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle()
    if (error) throw new Error(`Kunde inte hämta kassakonto: ${error.message}`)
    if (!data) return null
    const window = {
      from: options.windowFrom ?? defaultWindow(today).from,
      to: options.windowTo ?? defaultWindow(today).to,
    }
    status = await bankStatus(supabase, companyId, data as CashAccountRow, window, today)
  }
  if (parsed.kind === 'manual') {
    status = await getManualReconciliationStatus(supabase, companyId, parsed.accountNumber, {
      today,
      asOf: options.windowTo ?? today,
    })
  }
  if (!status) return null

  // The latest active sign-off rides along on every status read (page, v1,
  // MCP) so "avstämt t.o.m." never needs a second call.
  try {
    status.signoff = await getLatestSignoff(supabase, companyId, accountKey)
  } catch (err) {
    log.warn('sign-off read failed', { companyId, accountKey, error: err instanceof Error ? err.message : String(err) })
    status.signoff = null
  }

  // A manual account without a system specification has no live outside
  // balance; the one the signer stated for this very balansdag is the
  // attested truth, so the status shows it instead of "okänt".
  if (
    status.kind === 'manual' &&
    status.external_balance == null &&
    status.signoff &&
    status.signoff.external_balance != null &&
    status.signoff.through_date === status.as_of.slice(0, 10)
  ) {
    const external = status.signoff.external_balance
    const difference = status.ledger_balance == null ? null : roundOre(status.ledger_balance - external)
    status.external_balance = external
    status.difference = difference
    status.unexplained_difference = difference
    status.is_reconciled = difference != null && Math.abs(difference) < 0.005
  }
  return status
}
