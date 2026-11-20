/**
 * The sentence a refused bank-picker save answers with, naming the bank
 * account the refusal is about (crm#1021).
 *
 * save_bank_account_selection and promote_psd2_cash_account raise their
 * refusals by name. The ones about another row carry a DETAIL that identifies
 * it (public.cash_account_refusal_detail, 20261005124500): the ledger asked
 * for, the cash account holding it or being retired, and that row's bank
 * connection. A bare name told the user that "the ledger account is used by
 * another bank account" without saying which one, and a name the registry did
 * not know reached the picker as "Förfrågan innehåller ogiltiga uppgifter".
 * Here the detail becomes a Swedish sentence that names the account and says
 * what to do. Without a usable detail the registry's generic sentence stands.
 *
 * Pure: no Supabase, no logger.
 */

export interface RefusedCashAccount {
  id: string
  ledger_account: string
  name?: string
  iban_last4?: string
  currency?: string
  bank_name?: string
  /** A live bank connection syncs onto the row (not revoked or superseded). */
  connection_live?: boolean
}

export interface SelectionRefusalDetail {
  /** The ledger account the selection asked for. */
  ledger_account: string
  cash_account: RefusedCashAccount
  /** cash_account_retirement_dependencies() of a retired row, when it refused. */
  dependencies: string[]
}

const BAS_LEDGER = /^19[0-9]{2}$/

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The DETAIL of a selection refusal, or null when it is absent or not ours. */
export function parseSelectionRefusalDetail(details: unknown): SelectionRefusalDetail | null {
  if (typeof details !== 'string' || !details.trim().startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(details)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const detail = raw as Record<string, unknown>
  const account = detail.cash_account as Record<string, unknown> | undefined
  const ledger = text(detail.ledger_account)
  if (!ledger || !BAS_LEDGER.test(ledger) || typeof account !== 'object' || account === null) return null
  const id = text(account.id)
  const accountLedger = text(account.ledger_account)
  if (!id || !accountLedger) return null
  return {
    ledger_account: ledger,
    cash_account: {
      id,
      ledger_account: accountLedger,
      name: text(account.name),
      iban_last4: text(account.iban_last4),
      currency: text(account.currency),
      bank_name: text(account.bank_name),
      connection_live: account.connection_live === true,
    },
    dependencies: Array.isArray(detail.dependencies)
      ? detail.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
  }
}

/** The last four characters of an IBAN as the database reports them. */
export function ibanLast4(iban: string | null | undefined): string | undefined {
  const normalized = (iban ?? '').replace(/\s+/g, '').toUpperCase()
  return normalized ? normalized.slice(-4) : undefined
}

/**
 * "bankkontot Företagskonto (SEB ••1234)": the name the account goes by, its
 * bank and the IBAN tail the bank list and the transactions page show.
 */
export function bankAccountLabel(account: { name?: string | null; bank_name?: string | null; iban_last4?: string | null }): string {
  const name = text(account.name)
  const tags = [text(account.bank_name), account.iban_last4 ? `••${account.iban_last4}` : undefined].filter(Boolean)
  if (name) return tags.length > 0 ? `bankkontot ${name} (${tags.join(' ')})` : `bankkontot ${name}`
  if (tags.length > 0) return `bankkontot ${tags.join(' ')}`
  return 'ett annat bankkonto'
}

/** The label as a sentence subject: "Bankkontot Företagskonto (SEB ••1234)". */
function subject(label: string): string {
  return label === 'ett annat bankkonto' ? 'Bankkontot' : label.charAt(0).toUpperCase() + label.slice(1)
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`
}

const PICKER_PATH = 'Inställningar > Kopplingar > Bank, tre punkter vid den banken, Välj konton'

/**
 * A ledger another live bank connection syncs one of its accounts onto. Shared
 * by the route's own pre-check and the database's refusal for the same case.
 */
export function ledgerSyncedElsewhereMessage(holders: Array<{ ledger: string; label: string }>): string {
  if (holders.length === 1) {
    const [{ ledger, label }] = holders
    return `Bokföringskonto ${ledger} används redan av ${label}, ett annat bankkonto som hämtas via en annan bankkoppling. `
      + `Inget sparades. Välj ett annat bokföringskonto, eller ge först det kontot ett annat bokföringskonto: ${PICKER_PATH}.`
  }
  const named = holders.map(({ ledger, label }) => `${ledger} av ${label}`)
  return `Bokföringskontona används redan av bankkonton som hämtas via andra bankkopplingar: ${listJoin(named)}. `
    + 'Inget sparades. Välj andra bokföringskonton, eller ge först de kontona andra bokföringskonton: '
    + 'Inställningar > Kopplingar > Bank, tre punkter vid respektive bank, Välj konton.'
}

const DEPENDENCY_PHRASES: Record<string, string> = {
  'invoice-configuration': 'har betalningsuppgifter för fakturor',
  'invoice-default': 'är förvalt betalkonto för fakturor',
  'invoice-reference': 'står som betalkonto på fakturor',
  reconciliation: 'har avstämningar',
  'reconciliation-attachment': 'har underlag bifogade till en avstämning',
}

/**
 * The named sentence for a refusal `code` the selection save raised with
 * `detail`, or null when the registry's generic sentence should stand.
 */
export function namedSelectionRefusal(code: string, detail: SelectionRefusalDetail | null): string | null {
  if (!detail) return null
  const ledger = detail.ledger_account
  const account = detail.cash_account
  const label = bankAccountLabel(account)
  switch (code) {
    case 'CASH_ACCOUNT_LEDGER_CLAIMED':
      return `Bokföringskonto ${ledger} används redan av ${label}, som hämtas via en annan bankkoppling. Inget sparades. `
        + 'Hämtas samma bankkonto via två kopplingar: koppla från den andra under Inställningar > Kopplingar > Bank och spara sedan här igen. '
        + 'Annars väljer du ett annat bokföringskonto.'
    case 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT':
      if (account.connection_live) return ledgerSyncedElsewhereMessage([{ ledger, label }])
      return `Bokföringskonto ${ledger} tillhör redan ${label}, ett annat bankkonto (annat IBAN eller annan valuta). Inget sparades. `
        + 'Välj ett annat bokföringskonto. Används det kontot inte längre kan du ta bort det under Inställningar > Bokföring '
        + '(Verifikationsserier per bankkonto) och sedan spara här igen.'
    case 'BANK_SELECTION_YIELD_HAS_HISTORY':
      return `Bokföringskonto ${ledger} hör till ${label}, som inte synkas men har transaktioner eller används i fakturor eller avstämningar. `
        + 'Inget sparades. Välj ett annat bokföringskonto, eller markera först det kontot under Välj konton för dess bank, '
        + `ge det ett annat bokföringskonto och spara, och flytta sedan det här kontot till ${ledger}.`
    case 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES': {
      const from = account.ledger_account
      const reasons = [...new Set(detail.dependencies.map((d) => DEPENDENCY_PHRASES[d] ?? 'används på annat håll'))]
      const why = reasons.length > 0 ? listJoin(reasons) : 'används på annat håll'
      return `${subject(label)} kan inte flyttas från ${from} till ${ledger} automatiskt, eftersom kontot på ${from} ${why}. `
        + `Inget sparades. Behåll ${from}, eller kontakta supporten så hjälper vi dig att flytta det.`
    }
    case 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT':
      return `${subject(label)} på ${account.ledger_account} har ett annat IBAN eller en annan valuta än kontot du flyttar `
        + 'och kan inte slås ihop med det automatiskt. Inget sparades. Välj ett annat bokföringskonto, eller kontakta supporten.'
    case 'CASH_ACCOUNT_RETIREMENT_STILL_LIVE':
      return `${subject(label)} hämtas fortfarande via en annan bankkoppling och kan inte slås ihop automatiskt. Inget sparades. `
        + 'Koppla från den andra kopplingen under Inställningar > Kopplingar > Bank och spara sedan här igen.'
    default:
      return null
  }
}
