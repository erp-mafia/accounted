import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from './imbalance-diagnosis'
import { getLatestPostedVouchers } from './latest-vouchers'
import { roundOre, sumOre } from '@/lib/money'
import { preparesArsredovisning, resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  K2_BR_LAYOUT,
  k2BrSectionForAccount,
  k2LegalFormFor,
  type K2LegalForm,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import type {
  BalanceImbalanceDiagnosis,
  BalansrapportReport,
  BalansrapportRow,
  BalansrapportGroup,
  BalansrapportSection,
  LatestVoucherPerSeries,
} from '@/types'

const CLASS_LABELS: Record<number, string> = {
  1: '1 Tillgångar',
  2: '2 Eget kapital, obeskattade reserver, avsättningar och skulder',
}

/**
 * Accounts no balance-sheet post covers: a BAS group header such as 1200, or
 * another legal form's equity account (2010 in an aktiebolag). The
 * årsredovisning reports these balances as missing, so they are listed apart
 * rather than folded into a neighbouring heading.
 */
const UNCLASSIFIED = { key: 'unclassified', label: 'Ej klassificerade konton' }

/**
 * BAS kontogrupp 20, Eget kapital. A form that prepares no årsredovisning
 * (enskild firma: B10 Eget kapital in the K1 förenklat årsbokslut) has no
 * bundet/fritt split, so its whole equity group is one heading, owner
 * accounts 2010-2019 included.
 */
const EQUITY_ACCOUNT_GROUP = '20'

interface LayoutNode {
  key: string
  label: string
  sections?: ReadonlyArray<{ key: string; label: string }>
}

/**
 * Balansrapport: operational balance report.
 *
 * Lists every account in classes 1-2 with IB, period change, and UB, under
 * the balance-sheet headings of the årsredovisning (ÅRL bilaga 1, K2):
 * Anläggningstillgångar with its immateriella, materiella and finansiella
 * sections, Omsättningstillgångar, Eget kapital, Obeskattade reserver,
 * Avsättningar, Långfristiga and Kortfristiga skulder, each with subtotals.
 * The account-to-heading assignment is the K2 mapper's own
 * (k2BrSectionForAccount), so this report and the årsredovisning cannot
 * place an account differently. Unlike Balansräkning (formal), this keeps
 * account numbers and is meant for ongoing reconciliation.
 *
 * Accounts stay under their BAS-range heading whatever the sign of their
 * balance: the statutory reclassification of a credit 1630 into Skatteskulder
 * belongs to the årsredovisning, not to a per-account report.
 *
 * Sign convention: every row is shown debit-positive (debit - credit). Class 1
 * accounts (debit balance) render positive; class 2 accounts (credit balance)
 * render negative. This matches Fortnox/Visma/Bokio and lets the user verify
 * the balance by adding rows: total_assets_ub + total_equity_liabilities_ub
 * = beraknat_resultat (the running-year P&L residual, 0 after year-end close).
 */
export async function generateBalansrapport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { fromDate?: string; toDate?: string }
): Promise<BalansrapportReport> {
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  const effectiveFromDate = options?.fromDate ?? period.period_start
  const effectiveToDate = options?.toDate ?? period.period_end

  const entityType = await resolveCompanyEntityType(supabase, companyId)

  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    // Class 1-2 only, and 2099 must carry årets resultat.
    closingEntry: 'include',
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  })
  const balanceRows = trialBalance.rows.filter((r) => r.account_class === 1 || r.account_class === 2)

  // Forms that prepare an årsredovisning split equity into bundet and fritt
  // with the K2 table for the form; the others keep their equity together.
  const splitEquity = preparesArsredovisning(entityType)
  const sectionOf = sectionResolver(k2LegalFormFor(entityType), splitEquity)
  const groups: BalansrapportGroup[] = []
  for (const klass of [1, 2] as const) {
    const rows: BalansrapportRow[] = balanceRows
      .filter((r) => r.account_class === klass)
      .sort((a, b) => a.account_number.localeCompare(b.account_number))
      .flatMap((r) => {
        const ib = roundOre(r.opening_debit - r.opening_credit)
        const ub = roundOre(r.closing_debit - r.closing_credit)
        if (ib === 0 && ub === 0) return []
        return [{
          account_number: r.account_number,
          account_name: r.account_name,
          ib,
          ub,
          period_change: roundOre(ub - ib),
        }]
      })

    if (rows.length === 0) continue

    const layout = klass === 1 ? K2_BR_LAYOUT.assets : equityLiabilityLayout(splitEquity)
    const sections = buildSections(rows, layout, sectionOf)
    groups.push({
      class: klass,
      class_label: CLASS_LABELS[klass],
      sections,
      ...subtotals(sections.map((s) => ({ ib: s.subtotal_ib, ub: s.subtotal_ub }))),
    })
  }

  const totalAssetsUb = groups.find((g) => g.class === 1)?.subtotal_ub ?? 0
  const totalEquityLiabilitiesUb = groups.find((g) => g.class === 2)?.subtotal_ub ?? 0

  // Beräknat resultat: the residual on the balance side. With both classes in
  // debit-positive sign, assets are positive and eq_liab is negative; their sum
  // equals the running-year P&L residual. Trial balance guarantees
  // sum_all(debit - credit) = 0, so sum_balance = -sum_pl = revenues - costs.
  // After year-end close posts the result into 2099, the residual is 0.
  const beraknatResultat = roundOre(totalAssetsUb + totalEquityLiabilitiesUb)

  // An unbalanced trial balance here means the opening balance itself is
  // broken — double-entry guarantees period activity balances. Explain why
  // (usually a prior year's untransferred result) instead of leaving a bare
  // "Balanserar ej". Best-effort: a diagnosis failure never breaks the report.
  let imbalanceDiagnosis: BalanceImbalanceDiagnosis | undefined
  if (!trialBalance.isBalanced) {
    const differens = roundOre(trialBalance.totalDebit - trialBalance.totalCredit)
    try {
      const untransferred = await findUntransferredResults(supabase, companyId, {
        beforePeriodStart: period.period_start,
      })
      imbalanceDiagnosis = buildImbalanceDiagnosis(untransferred, differens) ?? undefined
    } catch {
      // Best-effort diagnosis only.
    }
  }

  // Reconciliation aid for the header: which vouchers are actually in here.
  // The balansrapport accumulates from the fiscal year start, so the window has
  // no lower bound beyond fiscal_period_id even when the user narrows fromDate.
  // Best-effort: a header nicety never breaks the report.
  let latestVouchers: LatestVoucherPerSeries[] = []
  try {
    latestVouchers = await getLatestPostedVouchers(supabase, companyId, fiscalPeriodId, {
      toDate: effectiveToDate,
    })
  } catch {
    // Best-effort header line only.
  }

  return {
    groups,
    total_assets_ub: totalAssetsUb,
    total_equity_liabilities_ub: totalEquityLiabilitiesUb,
    beraknat_resultat: beraknatResultat,
    is_balanced: trialBalance.isBalanced,
    period: { start: effectiveFromDate, end: effectiveToDate },
    ...(imbalanceDiagnosis ? { imbalance_diagnosis: imbalanceDiagnosis } : {}),
    ...(latestVouchers.length > 0 ? { latest_vouchers: latestVouchers } : {}),
  }
}

/** Which heading an account belongs under. */
function sectionResolver(
  legalForm: K2LegalForm,
  splitEquity: boolean,
): (accountNumber: string) => string | null {
  return (accountNumber) => {
    if (!splitEquity && accountNumber.startsWith(EQUITY_ACCOUNT_GROUP)) return 'egetKapital'
    return k2BrSectionForAccount(accountNumber, legalForm)
  }
}

/** The K2 equity-and-liabilities headings, with Eget kapital as one section when it is not split. */
function equityLiabilityLayout(splitEquity: boolean): ReadonlyArray<LayoutNode> {
  if (splitEquity) return K2_BR_LAYOUT.equityLiabilities
  return K2_BR_LAYOUT.equityLiabilities.map((node) =>
    node.key === 'egetKapital' ? { key: node.key, label: node.label } : node,
  )
}

/**
 * Place every row under its heading, in layout order, and drop empty
 * headings. A row whose heading is not in this class's layout lands in the
 * unclassified section, so the sections always add up to the class.
 */
function buildSections(
  rows: BalansrapportRow[],
  layout: ReadonlyArray<LayoutNode>,
  sectionOf: (accountNumber: string) => string | null,
): BalansrapportSection[] {
  const leafKeys = new Set(
    layout.flatMap((node) => (node.sections ? node.sections.map((s) => s.key) : [node.key])),
  )
  const rowsByKey = new Map<string, BalansrapportRow[]>()
  for (const row of rows) {
    const resolved = sectionOf(row.account_number)
    const key = resolved !== null && leafKeys.has(resolved) ? resolved : UNCLASSIFIED.key
    const bucket = rowsByKey.get(key)
    if (bucket) bucket.push(row)
    else rowsByKey.set(key, [row])
  }

  const leaf = (node: { key: string; label: string }): BalansrapportSection[] => {
    const leafRows = rowsByKey.get(node.key) ?? []
    return leafRows.length > 0 ? [section(node, leafRows, [])] : []
  }

  const sections = layout.flatMap((node) => {
    if (!node.sections) return leaf(node)
    const children = node.sections.flatMap(leaf)
    return children.length > 0 ? [section(node, [], children)] : []
  })
  return [...sections, ...leaf(UNCLASSIFIED)]
}

function section(
  node: { key: string; label: string },
  rows: BalansrapportRow[],
  children: BalansrapportSection[],
): BalansrapportSection {
  const parts = rows.length > 0
    ? rows.map((r) => ({ ib: r.ib, ub: r.ub }))
    : children.map((c) => ({ ib: c.subtotal_ib, ub: c.subtotal_ub }))
  return {
    key: node.key,
    label: node.label,
    total_label: `Summa ${node.label.charAt(0).toLocaleLowerCase('sv-SE')}${node.label.slice(1)}`,
    rows,
    sections: children,
    ...subtotals(parts),
  }
}

function subtotals(parts: Array<{ ib: number; ub: number }>): {
  subtotal_ib: number
  subtotal_change: number
  subtotal_ub: number
} {
  const ib = sumOre(parts.map((p) => p.ib))
  const ub = sumOre(parts.map((p) => p.ub))
  return { subtotal_ib: ib, subtotal_change: roundOre(ub - ib), subtotal_ub: ub }
}
