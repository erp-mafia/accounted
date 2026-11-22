/**
 * Choosing the skattekonto's ledger account (PH 175): read the choice, change
 * it, and draft the one-off transfer when lines already sit on the old
 * account. The resolver itself is ./skattekonto-account.ts.
 *
 * Changing the account moves nothing in the ledger. Posted verifikat stay on
 * the account they were booked on (BFL 5 kap. 5 §: a posted verifikat is
 * never edited); from the change on, booking, matching and the
 * reconciliation read the new account. When the old account still carries a
 * balance the user decides: the transfer is offered as a DRAFT verifikat
 * (drafted through the posting port, src/lib/posting) the user reviews and
 * posts, never posted here.
 *
 * Who: the choice is a company setting, so owners and admins only
 * (requireCompanyAdmin, same as every company_settings write); the draft is
 * an ordinary draft verifikat (any non-viewer).
 */
import { activateAccounts, createAccount } from '@/lib/bookkeeping/chart-of-accounts-service'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { committingOperationId } from '@/lib/pending-operations/commit-scope'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { accountBalanceThrough } from '@/lib/bookkeeping/account-balance'
import type { EntityType } from '@/types'
import {
  SKATTEKONTO_EQUITY_ACCOUNT_NAME,
  SKATTEKONTO_LEDGER_ACCOUNTS,
  deriveSkattekontoAccountFromBooks,
  isSkattekontoLedgerAccount,
  resolveSkattekontoAccount,
  skattekontoAccountChoices,
  type SkattekontoLedgerAccount,
} from './skattekonto-account'

export interface SkattekontoAccountBalance {
  account: SkattekontoLedgerAccount
  /** Debit minus credit through `as_of`, from the latest ingående balans on: the huvudbok figure. */
  balance: number
}

export interface SkattekontoAccountState {
  entity_type: EntityType
  /** What every skattekonto reader uses now. */
  account: SkattekontoLedgerAccount
  /** The stored choice; null when the company has not chosen (it then runs 1630). */
  chosen: SkattekontoLedgerAccount | null
  /** The accounts this legal form may choose, the default first. */
  choices: SkattekontoLedgerAccount[]
  /** What the books say (derive_skattekonto_account): 1630, 2012, or null with nothing booked on either. */
  books_suggest: SkattekontoLedgerAccount | null
  as_of: string
  /** Balance per choosable account, so a change shows what stays on the old one. */
  balances: SkattekontoAccountBalance[]
}

const ADMIN_MESSAGE = 'Bara företagets ägare eller en administratör kan ändra skattekontots konto.'

type Failure = Extract<OperationOutcome<never>, { ok: false }>
type StateRead = { ok: true; data: SkattekontoAccountState } | Failure

async function readState(ctx: OperationContext, asOf: string): Promise<StateRead> {
  const { supabase, companyId } = ctx
  const { data: settings, error } = await supabase
    .from('company_settings')
    .select('entity_type, skattekonto_account')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false, code: 'UNKNOWN_ERROR', error }
  const row = settings as { entity_type: string | null; skattekonto_account: string | null } | null
  const entityType = await resolveCompanyEntityType(supabase, companyId, row?.entity_type)
  const choices = skattekontoAccountChoices(entityType)
  const [account, booksSuggest] = await Promise.all([
    resolveSkattekontoAccount(supabase, companyId),
    deriveSkattekontoAccountFromBooks(supabase, companyId),
  ])
  const balances: SkattekontoAccountBalance[] = []
  for (const candidate of choices) {
    const balance = await accountBalanceThrough(supabase, companyId, candidate, asOf)
    if (balance === null) {
      return { ok: false, code: 'UNKNOWN_ERROR', messageSv: `Kunde inte läsa saldot på konto ${candidate}.` }
    }
    balances.push({ account: candidate, balance })
  }
  return {
    ok: true,
    data: {
      entity_type: entityType,
      account,
      chosen: isSkattekontoLedgerAccount(row?.skattekonto_account) ? row.skattekonto_account : null,
      choices,
      books_suggest: booksSuggest,
      as_of: asOf,
      balances,
    },
  }
}

export async function getSkattekontoAccountState(
  ctx: OperationContext,
  options: { asOf?: string } = {},
): Promise<OperationOutcome<SkattekontoAccountState>> {
  return readState(ctx, options.asOf ?? todayIsoStockholm())
}

/**
 * The account in the company's chart, active: 1630 is BAS 2026; 2012 is not
 * (it belongs to the BAS K1 chart), so it is created with the K1 name, as
 * eget kapital, on the NE-bilaga position of the other 201x accounts.
 */
async function ensureChartAccount(ctx: OperationContext, account: SkattekontoLedgerAccount): Promise<Failure | null> {
  const activated = await activateAccounts(ctx, [account])
  if (!activated.ok) return activated
  if (activated.dryRun || !activated.data.unknown.includes(account)) return null
  const created = await createAccount(ctx, {
    account_number: account,
    account_name: SKATTEKONTO_EQUITY_ACCOUNT_NAME,
    account_type: 'equity',
    normal_balance: 'debit',
    // Same NE-bilaga line (B10) as the other enskild firma equity accounts.
    sru_code: getBASReference('2013')?.sru_code ?? null,
    description:
      'Skattekontot hos Skatteverket i en enskild firma som för det i eget kapital (BAS K1). Firman delar skattekontot med ägaren.',
    plan_type: 'k1',
  })
  if (!created.ok && created.code !== 'ACCOUNT_EXISTS') return created
  return null
}

export interface SetSkattekontoAccountResult {
  state: SkattekontoAccountState
  previous_account: SkattekontoLedgerAccount
  /** The old account's balance when it is not zero: what a transfer verifikat would move. */
  left_on_previous: number | null
}

/**
 * Store the choice. 2012 only for a form that allows it (an enskild firma).
 * The chosen account is added to the chart (or reactivated) so booking on it
 * cannot fail on a missing account. Nothing in the ledger moves.
 */
export async function setSkattekontoAccount(
  ctx: OperationContext,
  account: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SetSkattekontoAccountResult>> {
  const denied = await requireCompanyAdmin(ctx, ADMIN_MESSAGE)
  if (denied) return denied
  if (!isSkattekontoLedgerAccount(account)) {
    return {
      ok: false,
      code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED',
      details: { account, allowed: [...SKATTEKONTO_LEDGER_ACCOUNTS] },
    }
  }
  const asOf = todayIsoStockholm()
  const before = await readState(ctx, asOf)
  if (!before.ok) return before
  if (!before.data.choices.includes(account)) {
    return {
      ok: false,
      code: 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED',
      details: { account, allowed: before.data.choices, entity_type: before.data.entity_type },
    }
  }
  const previous = before.data.account
  const leftOnPrevious =
    previous === account ? null : (before.data.balances.find((b) => b.account === previous)?.balance ?? 0) || null

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { account, previous_account: previous, left_on_previous: leftOnPrevious },
    }
  }

  const chartFailure = await ensureChartAccount(ctx, account)
  if (chartFailure) return chartFailure

  const saved = await writeCompanySettings(ctx, { skattekonto_account: account })
  if (!saved.ok) return saved
  ctx.log.info('skattekonto account chosen', { companyId: ctx.companyId, account, previous })

  const after = await readState(ctx, asOf)
  if (!after.ok) return after
  return { ok: true, data: { state: after.data, previous_account: previous, left_on_previous: leftOnPrevious } }
}

export interface SkattekontoTransferDraft {
  journal_entry_id: string
  entry_date: string
  from_account: SkattekontoLedgerAccount
  to_account: SkattekontoLedgerAccount
  amount: number
}

/**
 * The business event of the transfer draft, for the posting port: recorded
 * while POSTING_EVENTS is shadow or strict, never built while it is off.
 * Pure. A balance moved between two of the company's own accounts, booked
 * as an ordinary verifikat (source_type manual), so it is ledger.manual
 * filed under the skattekonto; no party, no subject and no direction, as no
 * money moves.
 */
export function skattekontoTransferBusinessEvent(args: {
  entryDate: string
  amount: number
  pendingOperationId: string | null
}): BusinessEventDraft {
  return {
    kind: 'ledger.manual',
    category: 'se.tax.settlement',
    occurredOn: args.entryDate,
    // A ledger balance: the ledger currency.
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    pendingOperationId: args.pendingOperationId,
    mappingVersion: mappingVersion('taxAccountTransfer'),
    jurisdiction: 'SE',
  }
}

/**
 * Draft (never post) one verifikat that moves the balance left on the
 * account the company no longer uses to the one it uses now, as of
 * `entryDate` (today by default). The user reviews and posts it; the draft
 * can be edited or deleted like any draft. Refused when nothing is left on
 * the old account or no open period covers the date.
 */
export async function createSkattekontoTransferDraft(
  ctx: OperationContext,
  input: { entry_date?: string } = {},
): Promise<OperationOutcome<SkattekontoTransferDraft>> {
  const entryDate = input.entry_date ?? todayIsoStockholm()
  const state = await readState(ctx, entryDate)
  if (!state.ok) return state
  const to = state.data.account
  const from = state.data.choices.find((a) => a !== to)
  const amount = from ? (state.data.balances.find((b) => b.account === from)?.balance ?? 0) : 0
  if (!from || amount === 0) {
    return {
      ok: false,
      code: 'SKATTEKONTO_TRANSFER_NOTHING_TO_MOVE',
      details: { from_account: from ?? null, to_account: to, entry_date: entryDate },
    }
  }
  const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId, entryDate)
  if (!fiscalPeriodId) {
    // No open period covers the date (most often the new räkenskapsår is not
    // created yet): the year is missing, not locked.
    return { ok: false, code: 'NO_OPEN_PERIOD_FOR_DATE', details: { entry_date: entryDate } }
  }
  const value = roundOre(Math.abs(amount))
  // A debit balance on the old account (an överskott at Skatteverket) moves
  // as a debit to the new one; a credit balance the other way round.
  const description = `Omföring av skattekontot från ${from} till ${to}`
  const lines =
    amount > 0
      ? [
          { account_number: to, debit_amount: value, credit_amount: 0, line_description: description },
          { account_number: from, debit_amount: 0, credit_amount: value, line_description: description },
        ]
      : [
          { account_number: from, debit_amount: value, credit_amount: 0, line_description: description },
          { account_number: to, debit_amount: 0, credit_amount: value, line_description: description },
        ]
  const chartFailure = await ensureChartAccount(ctx, to)
  if (chartFailure) return chartFailure
  // Posting port (step 2): a draft only, so draftJournalEntry; the engine
  // gets the input unchanged and, while POSTING_EVENTS is shadow or strict,
  // the event is linked to the draft before the user posts it.
  const entry = await postingPort.draftJournalEntry({
    supabase: ctx.supabase,
    companyId: ctx.companyId,
    userId: ctx.userId,
    // Built only while the port is on: off, the call is the one it was.
    event: () =>
      skattekontoTransferBusinessEvent({ entryDate, amount: value, pendingOperationId: committingOperationId() }),
    input: {
      fiscal_period_id: fiscalPeriodId,
      entry_date: entryDate,
      description,
      source_type: 'manual',
      notes:
        `Utkast skapat när skattekontots konto ändrades till ${to}. Saldot på ${from} per ${entryDate}. ` +
        'Kontrollera beloppet mot skattekontoutdraget innan du bokför.',
      lines,
    },
  })
  ctx.log.info('skattekonto transfer drafted', { companyId: ctx.companyId, from, to, journalEntryId: entry.id })
  return {
    ok: true,
    created: true,
    data: { journal_entry_id: entry.id, entry_date: entryDate, from_account: from, to_account: to, amount: value },
  }
}
