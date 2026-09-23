import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import {
  loadBalanceSheetSnapshot,
  loadSpecificationAmounts,
  SPECIFICATION_PROVIDERS,
  type BalanceSheetSnapshot,
} from '@/lib/reconciliation/manual-reconciliation'
import { getLatestSignoffs, mapSignoffRow } from '@/lib/reconciliation/signoff-store'
import { listAttachmentRowsInRange, type AttachmentRow } from '@/lib/reconciliation/attachments-store'
import type { ReconciliationAccount, ReconciliationSignoff } from '@/lib/reconciliation/schemas'
import { buildBokslutChecklist } from '@/lib/bokslut/checklist'
import type { BilagaAccount, BilagaAttachment, BilagaSignoff, BokslutsbilagorReport } from './bokslutsbilagor-types'

const log = createLogger('reports/bokslutsbilagor')

export interface BokslutsbilagorOptions {
  /** The acting user; without one the checklist skips the readiness-derived items (archive runs have no user). */
  userId?: string | null
  /** Resolves auth user ids to display labels (email / name); defaults to the id itself. */
  resolveUserLabels?: (ids: string[]) => Promise<Map<string, string>>
  appVersion?: string | null
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

const KIND_ORDER: Record<ReconciliationAccount['kind'], number> = { bank: 0, skattekonto: 1, manual: 2 }

function externalLabels(account: ReconciliationAccount, hasSpecification: boolean): { sv: string; en: string } {
  if (account.kind === 'bank') return { sv: 'Banken (saldo vid signering)', en: 'The bank (balance at sign-off)' }
  if (account.kind === 'skattekonto') return { sv: 'Skatteverket (saldo vid signering)', en: 'Skatteverket (balance at sign-off)' }
  if (hasSpecification) {
    const p = SPECIFICATION_PROVIDERS[account.account_number]
    return { sv: p.label_sv, en: p.label_en }
  }
  return { sv: 'Saldo enligt underlag (angivet vid signering)', en: 'Balance per supporting documents (stated at sign-off)' }
}

/**
 * The pärm for one räkenskapsår. Null when the period is not this company's.
 * One trial-balance read, one reconciliation list, one sign-off read per
 * flavour, one attachment read: no per-account status recomputation.
 */
export async function generateBokslutsbilagor(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  options: BokslutsbilagorOptions = {},
): Promise<BokslutsbilagorReport | null> {
  const [{ data: periodData, error: periodError }, { data: companyData }] = await Promise.all([
    supabase.from('fiscal_periods').select('id, name, period_start, period_end').eq('id', periodId).eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name, org_number').eq('id', companyId).maybeSingle(),
  ])
  if (periodError) throw new Error(`Kunde inte hämta räkenskapsår: ${periodError.message}`)
  const period = periodData as PeriodRow | null
  if (!period) return null
  const company = (companyData as { name: string | null; org_number: string | null } | null) ?? { name: null, org_number: null }
  const balansdag = period.period_end

  const [accounts, snapshot, balansdagSignoffs, latestSignoffs, attachmentRows, checklist] = await Promise.all([
    listReconciliationAccounts(supabase, companyId, { today: balansdag, windowFrom: period.period_start, windowTo: balansdag }),
    loadBalanceSheetSnapshot(supabase, companyId, balansdag).catch((err): BalanceSheetSnapshot | null => {
      log.warn('balance snapshot failed', { companyId, periodId, error: String(err) })
      return null
    }),
    signoffsOn(supabase, companyId, balansdag),
    getLatestSignoffs(supabase, companyId).catch(() => new Map<string, ReconciliationSignoff | null>()),
    listAttachmentRowsInRange(supabase, companyId, period.period_start, balansdag, { includeRemoved: true }).catch((err): AttachmentRow[] => {
      log.warn('attachment read failed', { companyId, periodId, error: String(err) })
      return []
    }),
    buildBokslutChecklist(supabase, companyId, options.userId ?? '', periodId, options.userId ? {} : { readiness: null }),
  ])

  const specifications = snapshot
    ? await loadSpecificationAmounts(
        supabase,
        companyId,
        snapshot,
        new Set(accounts.filter((a) => a.kind === 'manual' && SPECIFICATION_PROVIDERS[a.account_number]).map((a) => a.account_number)),
      )
    : new Map()

  const attachmentsByKey = new Map<string, AttachmentRow[]>()
  for (const row of attachmentRows) {
    attachmentsByKey.set(row.account_key, [...(attachmentsByKey.get(row.account_key) ?? []), row])
  }

  const userIds = new Set<string>()
  for (const s of balansdagSignoffs.values()) userIds.add(s.signed_by)
  for (const s of latestSignoffs.values()) if (s) userIds.add(s.signed_by)
  for (const a of attachmentRows) userIds.add(a.uploaded_by)
  for (const i of checklist?.items ?? []) if (i.done_by) userIds.add(i.done_by)
  let labels = new Map<string, string>()
  if (options.resolveUserLabels && userIds.size > 0) {
    try {
      labels = await options.resolveUserLabels([...userIds])
    } catch (err) {
      log.warn('user label resolution failed', { companyId, error: String(err) })
    }
  }
  const label = (id: string) => labels.get(id) ?? id

  const bilagor: BilagaAccount[] = [...accounts]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.account_number.localeCompare(b.account_number))
    .map((account): BilagaAccount => {
      const row = snapshot?.rows.get(account.account_number) ?? null
      const spec = account.kind === 'manual' ? specifications.get(account.account_number) : undefined
      const onDay = balansdagSignoffs.get(account.account_key) ?? null
      const latest = latestSignoffs.get(account.account_key) ?? null
      const chosen = onDay ?? latest
      const signoff: BilagaSignoff | null = chosen
        ? {
            id: chosen.id,
            through_date: chosen.through_date,
            on_balansdag: chosen.through_date === balansdag,
            external_balance: chosen.external_balance,
            ledger_balance: chosen.ledger_balance,
            unexplained_difference: chosen.unexplained_difference,
            note: chosen.note,
            signed_by: chosen.signed_by,
            signed_by_label: label(chosen.signed_by),
            signed_at: chosen.signed_at,
          }
        : null
      // The outside side: the system specification for the reskontra accounts,
      // else what was recorded at the balansdag sign-off (the feed's balance,
      // or the balance the signer stated).
      const external = spec ? spec.amount : onDay ? onDay.external_balance : null
      const closing = row ? row.closing_balance : (onDay?.ledger_balance ?? null)
      const difference = external != null && closing != null ? roundOre(closing - external) : null
      const labelsFor = externalLabels(account, Boolean(spec))
      return {
        account_key: account.account_key,
        kind: account.kind,
        account_number: account.account_number,
        name: account.name,
        opening_balance: row?.opening_balance ?? null,
        movement: row?.movement ?? null,
        closing_balance: closing,
        external_label_sv: labelsFor.sv,
        external_label_en: labelsFor.en,
        external_balance: external,
        difference,
        signoff,
        attachments: (attachmentsByKey.get(account.account_key) ?? []).map(
          (a): BilagaAttachment => ({
            id: a.id,
            through_date: a.through_date,
            file_name: a.file_name,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
            sha256: a.sha256,
            note: a.note,
            uploaded_by_label: label(a.uploaded_by),
            uploaded_at: a.uploaded_at,
            removed_at: a.removed_at,
            removed_reason: a.removed_reason,
          }),
        ),
      }
    })

  const signedOnDay = bilagor.filter((b) => b.signoff?.on_balansdag).length
  const signedOther = bilagor.filter((b) => b.signoff && !b.signoff.on_balansdag).length

  return {
    company: { name: company.name ?? '', org_number: company.org_number ?? null },
    period: { id: period.id, name: period.name, start: period.period_start, end: period.period_end },
    generated_at: new Date().toISOString(),
    app_version: options.appVersion ?? null,
    checklist: {
      items: (checklist?.items ?? []).map((i) => ({
        key: i.key,
        group: i.group,
        label_sv: i.label_sv,
        label_en: i.label_en,
        state: i.effective_state,
        done_at: i.done_at,
        done_by_label: i.done_by ? label(i.done_by) : null,
        note: i.note,
      })),
      summary: checklist?.summary ?? { total: 0, done: 0, not_applicable: 0, open: 0 },
    },
    accounts: bilagor,
    summary: {
      accounts: bilagor.length,
      signed_on_balansdag: signedOnDay,
      signed_other_date: signedOther,
      unsigned: bilagor.length - signedOnDay - signedOther,
      attachments: attachmentRows.filter((a) => !a.removed_at).length,
    },
  }
}

/** Active sign-offs whose through_date is exactly the balansdag, keyed by account. */
async function signoffsOn(supabase: SupabaseClient, companyId: string, throughDate: string): Promise<Map<string, ReconciliationSignoff>> {
  const out = new Map<string, ReconciliationSignoff>()
  const { data, error } = await supabase
    .from('account_reconciliations')
    .select('id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason')
    .eq('company_id', companyId)
    .eq('through_date', throughDate)
    .is('reopened_at', null)
  if (error) {
    log.warn('balansdag sign-off read failed', { companyId, throughDate, error: error.message })
    return out
  }
  for (const row of (data ?? []) as Parameters<typeof mapSignoffRow>[0][]) {
    const mapped = mapSignoffRow(row)
    out.set(mapped.account_key, mapped)
  }
  return out
}
