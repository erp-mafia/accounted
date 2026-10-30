import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { frameworkForYear } from '@/lib/bokslut/framework-for-year'
import type { AccountingFramework } from '@/types'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'

const log = createLogger('bokslut/checklist')

/**
 * The bokslut checklist: the closing steps a redovisningskonsult documents
 * per räkenskapsår (Reko 760/765), as a fixed catalogue in code with one
 * state row per item in bokslut_checklist_items. Steps the system can judge
 * (drafts, voucher gaps, trial balance, sign-offs through balansdagen, the
 * reskontra tie-outs) are computed live every time; a stored row overrides
 * them (typically "ej tillämpligt") and records the manual ones. The order
 * below is the order of the work.
 */

export type ChecklistState = 'open' | 'done' | 'not_applicable'
export type ChecklistGroup = 'avstamning' | 'periodisering' | 'vardering' | 'dispositioner' | 'kontroll' | 'rapportering'

export interface ChecklistItemDef {
  key: string
  group: ChecklistGroup
  label_sv: string
  label_en: string
  hint_sv?: string
  hint_en?: string
  /** True when the system computes the state itself; a stored row still overrides. */
  auto: boolean
  /** Where the work is done. */
  href?: string
  /** Only under these frameworks: not applicable (computed) in any other year. */
  frameworks?: readonly AccountingFramework[]
}

export const BOKSLUT_CHECKLIST: readonly ChecklistItemDef[] = [
  { key: 'bank_signed', group: 'avstamning', label_sv: 'Bankkonton avstämda och signerade per balansdagen', label_en: 'Bank accounts reconciled and signed off as of the balance sheet date', auto: true, href: '/reconciliation' },
  { key: 'skattekonto_signed', group: 'avstamning', label_sv: 'Skattekontot avstämt mot Skatteverket och signerat', label_en: 'Tax account reconciled against Skatteverket and signed off', auto: true, href: '/reconciliation?account=skattekonto' },
  { key: 'ar_reconciled', group: 'avstamning', label_sv: 'Kundfordringar stämda mot kundreskontran', label_en: 'Receivables agree with the customer ledger', auto: true, href: '/reconciliation?account=manual%3A1510' },
  { key: 'ap_reconciled', group: 'avstamning', label_sv: 'Leverantörsskulder stämda mot leverantörsreskontran', label_en: 'Payables agree with the supplier ledger', auto: true, href: '/reconciliation?account=manual%3A2440' },
  { key: 'balance_accounts_signed', group: 'avstamning', label_sv: 'Övriga balanskonton avstämda mot underlag och signerade', label_en: 'Other balance sheet accounts reconciled against documents and signed off', auto: true, href: '/reconciliation' },
  { key: 'underlag_attached', group: 'avstamning', label_sv: 'Underlag bifogat till avstämningarna (kontoutdrag, engagemangsbesked, reskontralistor)', label_en: 'Supporting documents attached to the reconciliations (statements, engagement letters, ledger lists)', auto: false, href: '/reconciliation' },
  { key: 'vat_settled', group: 'avstamning', label_sv: 'Momskontona avstämda mot lämnade deklarationer', label_en: 'VAT accounts agree with the filed returns', auto: false, href: '/reports/vat-declaration' },
  { key: 'accruals_posted', group: 'periodisering', label_sv: 'Periodiseringar bokförda (förutbetalda och upplupna poster)', label_en: 'Accruals and deferrals posted', auto: false, href: '/bookkeeping/year-end/periodisering' },
  { key: 'vacation_liability', group: 'periodisering', label_sv: 'Semesterlöneskuld och sociala avgifter på den avstämda', label_en: 'Vacation liability and its social fees reconciled', auto: false, href: '/reconciliation?account=manual%3A2920' },
  { key: 'inventory_valued', group: 'vardering', label_sv: 'Varulager inventerat och värderat (LVP)', label_en: 'Inventory counted and valued (lower of cost or market)', auto: false },
  { key: 'doubtful_receivables', group: 'vardering', label_sv: 'Osäkra kundfordringar bedömda och nedskrivna vid behov', label_en: 'Doubtful receivables assessed and written down where needed', auto: false },
  { key: 'depreciation_posted', group: 'vardering', label_sv: 'Avskrivningar bokförda enligt anläggningsregistret', label_en: 'Depreciation posted per the fixed asset register', auto: false, href: '/bookkeeping/year-end' },
  { key: 'impairment_indications', group: 'vardering', label_sv: 'Prövat om någon anläggningstillgång behöver skrivas ned (värdenedgång som kan antas bestå) och nedskrivningar bokförda', label_en: 'Checked whether any fixed asset needs a write-down (a decline in value expected to last) and write-downs posted', hint_sv: 'ÅRL 4 kap. 5 §, K3 27.3: indikationer som skada, föråldring, fallande marknadsvärde eller lägre avkastning. Görs per tillgång under Anläggningstillgångar.', hint_en: 'ÅRL 4 kap. 5 §, K3 27.3: indications such as damage, obsolescence, a falling market value or lower returns. Done per asset under Fixed assets.', auto: false, href: '/assets' },
  { key: 'k3_transition', group: 'vardering', label_sv: 'Övergången till K3 genomförd, om tidigare årsredovisningar upprättades enligt K2', label_en: 'Transition to K3 completed, if earlier annual reports were prepared under K2', hint_sv: 'K3 kapitel 35: komponentuppdelning vid övergången (35.18), uppskjuten skatt i ingångsbalansen eller lättnadsregeln 35.27, justeringar mot eget kapital i första K3-året (35.11).', hint_en: 'K3 chapter 35: component split at the transition (35.18), opening deferred tax or the 35.27 relief, adjustments against equity in the first K3 year (35.11).', auto: false, href: '/bookkeeping/year-end', frameworks: ['k3'] },
  { key: 'depreciation_review', group: 'vardering', label_sv: 'Nyttjandeperioder, restvärden och avskrivningsmetoder omprövade', label_en: 'Useful lives, residual values and depreciation methods reviewed', hint_sv: 'K3 17.15, 17.17 och 17.20: en ändring gäller framåt (K3 10.9) och planeras om från det som återstår.', hint_en: 'K3 17.15, 17.17 and 17.20: a change applies prospectively (K3 10.9) and the rest is planned from what is left.', auto: false, href: '/assets', frameworks: ['k3'] },
  { key: 'component_review', group: 'vardering', label_sv: 'Komponentuppdelningen kontrollerad för väsentliga tillgångar, utbytta delar borttagna', label_en: 'Component breakdown checked for significant assets, replaced parts derecognised', hint_sv: 'K3 17.4, 17.5 och 17.21A.', hint_en: 'K3 17.4, 17.5 and 17.21A.', auto: false, href: '/assets', frameworks: ['k3'] },
  { key: 'deferred_tax', group: 'dispositioner', label_sv: 'Uppskjuten skatt beräknad på temporära skillnader och bokförd', label_en: 'Deferred tax calculated on temporary differences and posted', hint_sv: 'K3 kap. 29. Obeskattade reserver redovisas brutto i juridisk person (K3 29.37).', hint_en: 'K3 chapter 29. Untaxed reserves stay gross in the legal entity (K3 29.37).', auto: false, href: '/bookkeeping/year-end', frameworks: ['k3'] },
  { key: 'dispositions_posted', group: 'dispositioner', label_sv: 'Bokslutsdispositioner bokförda (periodiseringsfond, överavskrivningar)', label_en: 'Appropriations posted (tax allocation reserve, excess depreciation)', auto: false, href: '/bookkeeping/year-end' },
  { key: 'tax_provision', group: 'dispositioner', label_sv: 'Årets skatt beräknad och bokförd', label_en: 'Current tax calculated and posted', auto: false, href: '/bookkeeping/year-end' },
  { key: 'no_drafts', group: 'kontroll', label_sv: 'Inga utkast kvar i perioden', label_en: 'No draft entries left in the period', auto: true, href: '/bookkeeping?status=draft' },
  { key: 'voucher_gaps_explained', group: 'kontroll', label_sv: 'Luckor i verifikationsnummerserien förklarade', label_en: 'Voucher number gaps explained', auto: true },
  { key: 'trial_balance_balanced', group: 'kontroll', label_sv: 'Saldobalansen balanserar', label_en: 'The trial balance balances', auto: true, href: '/reports/saldobalans' },
  { key: 'annual_accounts_reviewed', group: 'rapportering', label_sv: 'Årsbokslut eller årsredovisning upprättat och granskat', label_en: 'Annual accounts or annual report prepared and reviewed', auto: false, href: '/bookkeeping/year-end/arsredovisning' },
]

export interface ChecklistRow {
  item_key: string
  state: ChecklistState
  note: string | null
  done_by: string | null
  done_at: string | null
  updated_by: string
  updated_at: string
}

export interface ChecklistItem extends ChecklistItemDef {
  /** What the system computes, null for manual items or when it could not be computed. */
  auto_state: ChecklistState | null
  /** The stored row's state, null when nobody has touched the item. */
  stored_state: ChecklistState | null
  /** stored_state, else auto_state, else open. */
  effective_state: ChecklistState
  note: string | null
  done_by: string | null
  done_at: string | null
}

export interface BokslutChecklist {
  period: { id: string; name: string; period_start: string; period_end: string }
  items: ChecklistItem[]
  summary: { total: number; done: number; not_applicable: number; open: number }
}

/** The subset of the readiness validation the auto items read. */
export interface ChecklistReadinessInput {
  draftCount: number
  unexplainedGaps: number
  trialBalanceBalanced: boolean
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

function allSigned(accounts: ReconciliationAccount[], through: string): ChecklistState {
  if (accounts.length === 0) return 'not_applicable'
  return accounts.every((a) => a.signed_off_through != null && a.signed_off_through >= through) ? 'done' : 'open'
}

function tieOut(accounts: ReconciliationAccount[], accountNumber: string, through: string): ChecklistState {
  const account = accounts.find((a) => a.kind === 'manual' && a.account_number === accountNumber)
  if (!account) return 'not_applicable'
  if (account.signed_off_through != null && account.signed_off_through >= through) return 'done'
  return account.status?.state === 'reconciled' ? 'done' : 'open'
}

/** Auto states from the reconciliation list and the readiness counts; pure so it is testable without a client. */
export function computeAutoStates(
  accounts: ReconciliationAccount[] | null,
  readiness: ChecklistReadinessInput | null,
  periodEnd: string,
  /** The year's framework; null when it could not be read (no step is then ruled out). */
  framework: AccountingFramework | null = null,
): Map<string, ChecklistState> {
  const out = new Map<string, ChecklistState>()
  if (framework) {
    for (const def of BOKSLUT_CHECKLIST) {
      if (def.frameworks && !def.frameworks.includes(framework)) out.set(def.key, 'not_applicable')
    }
  }
  if (accounts) {
    out.set('bank_signed', allSigned(accounts.filter((a) => a.kind === 'bank' && !a.superseded_by), periodEnd))
    out.set('skattekonto_signed', allSigned(accounts.filter((a) => a.kind === 'skattekonto'), periodEnd))
    out.set('ar_reconciled', tieOut(accounts, '1510', periodEnd))
    out.set('ap_reconciled', tieOut(accounts, '2440', periodEnd))
    out.set('balance_accounts_signed', allSigned(accounts.filter((a) => a.kind === 'manual'), periodEnd))
  }
  if (readiness) {
    out.set('no_drafts', readiness.draftCount === 0 ? 'done' : 'open')
    out.set('voucher_gaps_explained', readiness.unexplainedGaps === 0 ? 'done' : 'open')
    out.set('trial_balance_balanced', readiness.trialBalanceBalanced ? 'done' : 'open')
  }
  return out
}

/** Merge catalogue, auto states and stored rows into the checklist; pure. */
export function assembleChecklist(
  period: PeriodRow,
  autoStates: Map<string, ChecklistState>,
  rows: ChecklistRow[],
): BokslutChecklist {
  const byKey = new Map(rows.map((r) => [r.item_key, r]))
  const items: ChecklistItem[] = BOKSLUT_CHECKLIST.map((def) => {
    const row = byKey.get(def.key)
    // A framework-scoped step is computed as not applicable in other years.
    const auto = def.auto || def.frameworks ? (autoStates.get(def.key) ?? null) : null
    return {
      ...def,
      auto_state: auto,
      stored_state: row?.state ?? null,
      effective_state: row?.state ?? auto ?? 'open',
      note: row?.note ?? null,
      done_by: row?.done_by ?? null,
      done_at: row?.done_at ?? null,
    }
  })
  const summary = {
    total: items.length,
    done: items.filter((i) => i.effective_state === 'done').length,
    not_applicable: items.filter((i) => i.effective_state === 'not_applicable').length,
    open: items.filter((i) => i.effective_state === 'open').length,
  }
  return { period, items, summary }
}

export interface BuildChecklistOptions {
  /** Pass the wizard's validation to avoid recomputing it; computed when absent. */
  readiness?: ChecklistReadinessInput | null
  /**
   * The period's reconciliation list (listReconciliationAccounts over the
   * period, today = period_end) when the caller reads it anyway; read here
   * when absent. A failed read degrades the auto states either way.
   */
  accounts?: Promise<ReconciliationAccount[]>
}

/** The checklist for one period, or null when the period is not this company's. */
export async function buildBokslutChecklist(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: BuildChecklistOptions = {},
): Promise<BokslutChecklist | null> {
  const { data: periodData, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (periodError) throw new Error(`Kunde inte hämta räkenskapsår: ${periodError.message}`)
  const period = periodData as PeriodRow | null
  if (!period) return null

  // The live inputs are advisory: a failed read leaves the auto items without
  // a computed state rather than hiding the checklist. They read alongside
  // the checklist's own rows.
  const accountsRead =
    options.accounts ??
    listReconciliationAccounts(supabase, companyId, {
      today: period.period_end,
      windowFrom: period.period_start,
      windowTo: period.period_end,
    })
  // Awaited below; this only keeps a failure that lands earlier from counting as unhandled.
  accountsRead.catch(() => undefined)
  const readinessRead: Promise<ChecklistReadinessInput | null> =
    options.readiness !== undefined
      ? Promise.resolve(options.readiness)
      : validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId).then(
          (v) => ({ draftCount: v.draftCount, unexplainedGaps: v.unexplainedGaps.length, trialBalanceBalanced: v.trialBalanceBalanced }),
          (err) => {
            log.warn('readiness unavailable for checklist', { companyId, fiscalPeriodId, error: String(err) })
            return null
          },
        )

  const { data: rowData, error: rowError } = await supabase
    .from('bokslut_checklist_items')
    .select('item_key, state, note, done_by, done_at, updated_by, updated_at')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
  if (rowError) throw new Error(`Kunde inte hämta bokslutschecklistan: ${rowError.message}`)
  const rows = (rowData ?? []) as ChecklistRow[]

  let accounts: ReconciliationAccount[] | null = null
  try {
    accounts = await accountsRead
  } catch (err) {
    log.warn('reconciliation accounts unavailable for checklist', { companyId, fiscalPeriodId, error: String(err) })
  }
  const readiness = await readinessRead
  let framework: AccountingFramework | null = null
  try {
    framework = await frameworkForYear(supabase, companyId, fiscalPeriodId)
  } catch (err) {
    log.warn('framework unavailable for checklist', { companyId, fiscalPeriodId, error: String(err) })
  }

  const checklist = assembleChecklist(period, computeAutoStates(accounts, readiness, period.period_end, framework), rows)
  // Where the stock count is on, the inventory step leads to it; signing a
  // count marks the step done (lib/bokslut/stock-count/signing.ts).
  if (stockCountEnabledFor(companyId)) {
    checklist.items = checklist.items.map((item) =>
      item.key === 'inventory_valued' ? { ...item, href: STOCK_COUNT_HREF } : item,
    )
  }
  return checklist
}

/** The stock count page under bokslut. */
export const STOCK_COUNT_HREF = '/bookkeeping/year-end/inventering'

export type ChecklistErrorCode = 'UNKNOWN_ITEM' | 'INVALID_STATE' | 'NOTE_TOO_LONG'

export class BokslutChecklistError extends Error {
  readonly code: ChecklistErrorCode
  constructor(message: string, code: ChecklistErrorCode) {
    super(message)
    this.name = 'BokslutChecklistError'
    this.code = code
  }
}

export interface SetChecklistItemInput {
  item_key: string
  state: ChecklistState
  note?: string | null
}

/** Upsert one item's state as the acting user; returns the stored row. */
export async function setChecklistItem(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: SetChecklistItemInput,
): Promise<ChecklistRow> {
  if (!BOKSLUT_CHECKLIST.some((d) => d.key === input.item_key)) {
    throw new BokslutChecklistError('Okänt steg i checklistan.', 'UNKNOWN_ITEM')
  }
  if (!['open', 'done', 'not_applicable'].includes(input.state)) {
    throw new BokslutChecklistError('Ogiltigt läge.', 'INVALID_STATE')
  }
  const note = input.note?.trim() ? input.note.trim() : null
  if (note && note.length > 2000) {
    throw new BokslutChecklistError('Noteringen är för lång.', 'NOTE_TOO_LONG')
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('bokslut_checklist_items')
    .upsert(
      {
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        item_key: input.item_key,
        state: input.state,
        note,
        done_by: input.state === 'open' ? null : userId,
        done_at: input.state === 'open' ? null : now,
        updated_by: userId,
        updated_at: now,
      },
      { onConflict: 'company_id,fiscal_period_id,item_key' },
    )
    .select('item_key, state, note, done_by, done_at, updated_by, updated_at')
    .single()
  if (error) throw new Error(`Kunde inte spara checklistan: ${error.message}`)
  return data as ChecklistRow
}
