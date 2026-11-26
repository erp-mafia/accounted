import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'
import { mappingPatternNamesCounterparty } from '@/lib/bookkeeping/counterparty-templates'
import { mappingRuleAccount } from '@/lib/bookkeeping/bank-leg'
import { AUTO_LEARNED_MAPPING_SOURCE, readsAutoLearnedMappingRules } from '@/lib/bookkeeping/mapping-engine'

// Ledger context: derived booking patterns for the Accounted://ledger/context
// MCP resource. Everything here is computed by code from ledger data; the LLM
// never derives these numbers.

/**
 * Patterns below this dominant share are noise, not signal: an agent should
 * ask rather than follow. Mirrors the confidence-floor thinking from the bank
 * recon overhaul (#880).
 */
const DOMINANT_SHARE_FLOOR = 0.7
const WINDOW_MONTHS = 12

/**
 * An imported counterparty needs this many verifikat before it is a pattern.
 * A bank-row pattern carries a person's or agent's categorization; an
 * imported one is only the old system's text and lines, and a single
 * imported verifikat predicts the next one's account clearly worse than two
 * or more do.
 */
const MIN_IMPORTED_VOUCHERS = 2

// Hard caps keeping the serialized payload under its 12 KB budget even on
// dense tenants (the RPC returns up to 20/25/15; these trim further). Sized
// together: the evidence objects and the supplier section made the previous
// 20/20 caps overflow the budget on a dense fixture.
const MAX_COUNTERPARTY_PATTERNS = 15
const MAX_SUPPLIER_PATTERNS = 10
const MAX_EXPLICIT_RULES = 15

export interface AccountUsage {
  account_number: string
  account_name: string | null
  postings_12m: number
  last_used: string
}

/**
 * Count-grounded evidence for a dominant pattern: "seen 47, agree 45" plus
 * recency. Agents over-trust bare printed ratios (they read 0.96 as safety,
 * not frequency), so the raw counts ride along and the digest description
 * frames this as historical frequency, never as "safe to auto-post".
 */
export interface PatternEvidence {
  seen_12m: number
  agree: number
  share: number
  last_booked: string
}

export interface CounterpartyPattern {
  counterparty: string
  dominant: {
    /** Null for imported verifikat: the previous system had no categories. */
    category: string | null
    account_number: string | null
    vat_treatment: string | null
  }
  evidence: PatternEvidence
  /**
   * The basis: 'history' bank rows booked in Accounted, 'template' the same
   * with the learned template's account and VAT, 'imported_vouchers'
   * verifikat migrated from the previous system (evidence counts verifikat).
   */
  source: 'history' | 'template' | 'imported_vouchers'
  /**
   * imported_vouchers only: how those verifikat settled. 'payable' or
   * 'receivable' means the history ran through leverantörs- or kundreskontra,
   * so a bank payment settles the open invoice instead of booking the account.
   */
  settled_via?: 'bank' | 'payable' | 'receivable'
}

export interface SupplierPattern {
  supplier: string
  dominant: {
    account_number: string
    vat_treatment: string | null
  }
  evidence: PatternEvidence
  source: 'supplier_invoices'
}

export interface ExplicitRule {
  rule_name: string
  match: string
  account_number: string | null
  vat_treatment: string | null
  source: 'mapping_rule'
}

export interface LedgerContext {
  meta: {
    computed_at: string
    window: { from: string; to: string }
    coverage: { posted_entries_window: number }
  }
  account_usage: AccountUsage[]
  counterparty_patterns: CounterpartyPattern[]
  supplier_patterns: SupplierPattern[]
  explicit_rules: ExplicitRule[]
  vat_profile: {
    registered: boolean
    moms_period: string | null
    treatments_used_12m: string[]
  }
  conventions: {
    accounting_method: string | null
    voucher_series_in_use: string[]
    salary_run_active: boolean
    typical_booking_lag_days: number | null
  }
}

interface UsageStatsRow {
  account_usage: Array<{
    account_number: string
    account_name: string | null
    postings: number
    last_used: string
  }>
  counterparty_patterns: Array<{
    counterparty: string
    counterparty_key: string
    occurrences: number
    last_booked: string
    dominant_category: string | null
    dominant_category_count: number
    dominant_account_number: string | null
  }>
  // Absent until migration 20261109090100 is applied: read as none.
  imported_counterparty_patterns?: Array<{
    counterparty: string
    counterparty_key: string
    vouchers: number
    last_booked: string
    settled_via: 'bank' | 'payable' | 'receivable'
    dominant_account_number: string | null
    dominant_account_count: number
    vat_treatment: string | null
    vat_treatment_count: number
  }>
  supplier_patterns: Array<{
    supplier: string
    invoices: number
    last_invoice: string
    vat_treatment: string | null
    dominant_account_number: string | null
    dominant_account_count: number
  }>
  vat_treatments_used: string[]
  median_booking_lag_days: number | null
}

// Not money, but roundOre is the repo's canonical 2dp rounding helper.
function share(agree: number, seen: number): number {
  return seen > 0 ? roundOre(agree / seen) : 0
}

/**
 * The company's explicit rules: authoritative, listed separately from
 * observed patterns (instruction vs observation). `autoLearned` says whether
 * the rows a booking wrote are part of the read (a company's row with the
 * source AUTO_LEARNED_MAPPING_SOURCE, mapping-engine isAutoLearnedMappingRule);
 * without them it is the rows a person described. The one place a read of
 * the explicit rules leaves the learned rows out.
 */
function explicitRulesRead(supabase: SupabaseClient, companyId: string, autoLearned: boolean) {
  const rules = supabase
    .from('mapping_rules')
    .select('rule_name, merchant_pattern, description_pattern, debit_account, credit_account, vat_treatment')
    .eq('company_id', companyId)
    .eq('is_active', true)
  return (autoLearned ? rules : rules.neq('source', AUTO_LEARNED_MAPPING_SOURCE))
    .order('priority', { ascending: true })
    .limit(25)
}

/** A mapping_rules row as explicitRulesRead selects it. */
interface ExplicitRuleRow {
  rule_name: string
  merchant_pattern: string | null
  description_pattern: string | null
  debit_account: string | null
  credit_account?: string | null
  vat_treatment: string | null
}

/**
 * The explicit rules in the rows of explicitRulesRead, as the bookkeeping
 * profile lists them and the briefing sends them. A rule on a text that
 * names no one ("INSÄTTNING") is never applied (mapping-engine matchesRule),
 * so it is no instruction to the agent; a rule that matches nothing is left
 * out; the first MAX_EXPLICIT_RULES are kept. Pure.
 */
export function explicitRulesFrom(rows: ReadonlyArray<ExplicitRuleRow> | null | undefined): ExplicitRule[] {
  return (rows ?? [])
    .filter((r) => !r.merchant_pattern || mappingPatternNamesCounterparty(r.merchant_pattern))
    .map((r) => ({
      rule_name: r.rule_name,
      match: r.merchant_pattern ?? r.description_pattern ?? '',
      account_number: mappingRuleAccount(r),
      vat_treatment: r.vat_treatment,
      source: 'mapping_rule' as const,
    }))
    .filter((r) => r.match !== '')
    .slice(0, MAX_EXPLICIT_RULES)
}

/**
 * The rules the company set itself: its explicit rules without the rows a
 * booking learned, for every company, whether or not its learned rows are
 * read elsewhere (readsAutoLearnedMappingRules). The same read and the same
 * rule as buildLedgerContext lists under explicit_rules, less those rows and
 * without the ledger statistics around them. Throws when the read fails: an
 * empty list would claim the company has no rules.
 */
export async function readWrittenRules(supabase: SupabaseClient, companyId: string): Promise<ExplicitRule[]> {
  const { data, error } = await explicitRulesRead(supabase, companyId, false)
  if (error) throw new Error(`written rules read failed: ${error.message}`)
  return explicitRulesFrom(data)
}

/** The voucher series a company has numbered in (voucher_sequences rows), each once, in order. */
export function voucherSeriesInUse(rows: ReadonlyArray<{ voucher_series: unknown }> | null | undefined): string[] {
  return [...new Set((rows ?? []).map((v) => v.voucher_series as string))].sort()
}

export async function buildLedgerContext(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<LedgerContext> {
  // The window ends on the Swedish calendar day and reaches back from it.
  const today = todayIsoStockholm(now)
  const fromDate = addMonthsIso(today, -WINDOW_MONTHS)

  const [statsRes, settingsRes, rulesRes, templatesRes, entryCountRes, voucherSeriesRes, salaryRes] =
    await Promise.all([
      supabase.rpc('get_ledger_usage_stats', {
        p_company_id: companyId,
        p_from_date: fromDate,
      }),

      supabase
        .from('company_settings')
        .select('vat_registered, moms_period, accounting_method, pays_salaries')
        .eq('company_id', companyId)
        .maybeSingle(),

      // The learned rows are left out where they are not read: a row no
      // reader takes is no instruction to the agent.
      explicitRulesRead(supabase, companyId, readsAutoLearnedMappingRules(companyId)),

      // Learned counterparty templates carry vat_treatment, which the RPC's
      // journal-side aggregation cannot see; merged into patterns below.
      supabase
        .from('categorization_templates')
        .select('counterparty_name, debit_account, vat_treatment, occurrence_count, confidence, last_seen_date')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('occurrence_count', { ascending: false })
        .limit(50),

      supabase
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .gte('entry_date', fromDate),

      supabase
        .from('voucher_sequences')
        .select('voucher_series')
        .eq('company_id', companyId),

      supabase
        .from('salary_runs')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .gte('payment_date', fromDate),
    ])

  if (statsRes.error) {
    throw new Error(`ledger usage stats failed: ${statsRes.error.message}`)
  }
  // Secondary reads also fail loud: silently mapping a failed read to [] would
  // make "explicit_rules: []" claim the company has no rules when the truth is
  // "read failed". The briefing digest wraps this call in try/catch and omits
  // the stanza; the resource surfaces the error instead of lying.
  const secondary: Array<[string, { error: { message: string } | null }]> = [
    ['company_settings', settingsRes],
    ['mapping_rules', rulesRes],
    ['categorization_templates', templatesRes],
    ['journal_entries count', entryCountRes],
    ['voucher_sequences', voucherSeriesRes],
    ['salary_runs count', salaryRes],
  ]
  for (const [label, res] of secondary) {
    if (res.error) {
      throw new Error(`ledger context read failed (${label}): ${res.error.message}`)
    }
  }
  const stats = (statsRes.data ?? {
    account_usage: [],
    counterparty_patterns: [],
    supplier_patterns: [],
    vat_treatments_used: [],
    median_booking_lag_days: null,
  }) as UsageStatsRow

  const settings = settingsRes.data

  // categorization_templates.counterparty_name is stored normalized through
  // normalizeCounterpartyName(); the RPC returns the identical key (its SQL
  // mirror, normalize_counterparty_key), so this join is exact.
  const templateByKey = new Map(
    (templatesRes.data ?? []).map((t) => [t.counterparty_name, t]),
  )

  const counterpartyPatterns: CounterpartyPattern[] = []
  for (const p of stats.counterparty_patterns ?? []) {
    if (counterpartyPatterns.length >= MAX_COUNTERPARTY_PATTERNS) break
    if (!p.dominant_category) continue
    const patternShare = share(p.dominant_category_count, p.occurrences)
    if (patternShare < DOMINANT_SHARE_FLOOR) continue
    const template = templateByKey.get(p.counterparty_key)
    counterpartyPatterns.push({
      counterparty: p.counterparty,
      dominant: {
        category: p.dominant_category,
        account_number: template?.debit_account ?? p.dominant_account_number,
        vat_treatment: template?.vat_treatment ?? null,
      },
      evidence: {
        seen_12m: p.occurrences,
        agree: p.dominant_category_count,
        share: patternShare,
        last_booked: p.last_booked,
      },
      source: template ? 'template' : 'history',
    })
  }

  // Imported verifikat fill the slots the bank rows leave: Accounted's own
  // bookings are the newer practice and keep precedence, and a counterparty
  // whose bank rows were categorized (even mixed, below the floor) is never
  // overridden by the previous system's history. Their VAT treatments join
  // the observed profile.
  const bankKeys = new Set(
    (stats.counterparty_patterns ?? []).filter((p) => p.dominant_category).map((p) => p.counterparty_key),
  )
  const importedTreatments: string[] = []
  for (const p of stats.imported_counterparty_patterns ?? []) {
    if (p.vouchers < MIN_IMPORTED_VOUCHERS || !p.dominant_account_number) continue
    const patternShare = share(p.dominant_account_count, p.vouchers)
    if (patternShare < DOMINANT_SHARE_FLOOR) continue
    const vatTreatment =
      p.vat_treatment && share(p.vat_treatment_count, p.dominant_account_count) >= DOMINANT_SHARE_FLOOR
        ? p.vat_treatment
        : null
    if (vatTreatment) importedTreatments.push(vatTreatment)
    if (bankKeys.has(p.counterparty_key) || counterpartyPatterns.length >= MAX_COUNTERPARTY_PATTERNS) continue
    counterpartyPatterns.push({
      counterparty: p.counterparty,
      dominant: {
        category: null,
        account_number: p.dominant_account_number,
        vat_treatment: vatTreatment,
      },
      evidence: {
        seen_12m: p.vouchers,
        agree: p.dominant_account_count,
        share: patternShare,
        last_booked: p.last_booked,
      },
      source: 'imported_vouchers',
      settled_via: p.settled_via,
    })
  }
  const treatmentsUsed = stats.vat_treatments_used ?? []
  const vatTreatmentsUsed = [
    ...treatmentsUsed,
    ...[...new Set(importedTreatments)].filter((t) => !treatmentsUsed.includes(t)).sort(),
  ]

  const supplierPatterns: SupplierPattern[] = []
  for (const s of stats.supplier_patterns ?? []) {
    if (supplierPatterns.length >= MAX_SUPPLIER_PATTERNS) break
    if (!s.dominant_account_number) continue
    const patternShare = share(s.dominant_account_count, s.invoices)
    if (patternShare < DOMINANT_SHARE_FLOOR) continue
    supplierPatterns.push({
      supplier: s.supplier,
      dominant: {
        account_number: s.dominant_account_number,
        vat_treatment: s.vat_treatment,
      },
      evidence: {
        seen_12m: s.invoices,
        agree: s.dominant_account_count,
        share: patternShare,
        last_booked: s.last_invoice,
      },
      source: 'supplier_invoices',
    })
  }

  const explicitRules = explicitRulesFrom(rulesRes.data)

  const voucherSeries = voucherSeriesInUse(voucherSeriesRes.data)

  return {
    meta: {
      computed_at: now.toISOString(),
      window: { from: fromDate, to: today },
      coverage: { posted_entries_window: entryCountRes.count ?? 0 },
    },
    account_usage: (stats.account_usage ?? []).map((a) => ({
      account_number: a.account_number,
      account_name: a.account_name,
      postings_12m: a.postings,
      last_used: a.last_used,
    })),
    counterparty_patterns: counterpartyPatterns,
    supplier_patterns: supplierPatterns,
    explicit_rules: explicitRules,
    vat_profile: {
      registered: settings?.vat_registered ?? false,
      moms_period: settings?.moms_period ?? null,
      treatments_used_12m: vatTreatmentsUsed,
    },
    conventions: {
      accounting_method: settings?.accounting_method ?? null,
      voucher_series_in_use: voucherSeries,
      salary_run_active: (salaryRes.count ?? 0) > 0,
      typical_booking_lag_days:
        stats.median_booking_lag_days === null ? null : Math.round(stats.median_booking_lag_days),
    },
  }
}

/**
 * The ledger_context stanza of the agent briefing: the top patterns with
 * their basis (source, settled_via) and VAT, so an agent can weigh bank-row
 * evidence against imported verifikat without reading the full resource.
 */
export function buildLedgerDigest(ctx: LedgerContext) {
  return {
    resource_uri: 'Accounted://ledger/context',
    window_from: ctx.meta.window.from,
    posted_entries_window: ctx.meta.coverage.posted_entries_window,
    top_counterparty_patterns: ctx.counterparty_patterns.slice(0, 5).map((p) => ({
      counterparty: p.counterparty,
      dominant_category: p.dominant.category,
      dominant_account_number: p.dominant.account_number,
      vat_treatment: p.dominant.vat_treatment,
      source: p.source,
      ...(p.settled_via ? { settled_via: p.settled_via } : {}),
      evidence: {
        seen_12m: p.evidence.seen_12m,
        agree: p.evidence.agree,
        last_booked: p.evidence.last_booked,
      },
    })),
    top_supplier_patterns: ctx.supplier_patterns.slice(0, 3).map((s) => ({
      supplier: s.supplier,
      dominant_account_number: s.dominant.account_number,
      vat_treatment: s.dominant.vat_treatment,
      evidence: {
        seen_12m: s.evidence.seen_12m,
        agree: s.evidence.agree,
        last_booked: s.evidence.last_booked,
      },
    })),
  }
}
