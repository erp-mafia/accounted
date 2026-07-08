import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

// Ledger context: derived booking patterns for the Accounted://ledger/context
// MCP resource. Everything here is computed by code from ledger data; the LLM
// never derives these numbers (design: dev_docs/ledger_context_resource.md).

/**
 * Patterns below this dominant share are noise, not signal: an agent should
 * ask rather than follow. Mirrors the confidence-floor thinking from the bank
 * recon overhaul (#880).
 */
const DOMINANT_SHARE_FLOOR = 0.7
const WINDOW_MONTHS = 12

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
    category: string
    account_number: string | null
    vat_treatment: string | null
  }
  evidence: PatternEvidence
  source: 'history' | 'template'
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

function windowFrom(now: Date): string {
  const from = new Date(now)
  from.setUTCMonth(from.getUTCMonth() - WINDOW_MONTHS)
  return from.toISOString().slice(0, 10)
}

// Not money, but roundOre is the repo's canonical 2dp rounding helper.
function share(agree: number, seen: number): number {
  return seen > 0 ? roundOre(agree / seen) : 0
}

export async function buildLedgerContext(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<LedgerContext> {
  const fromDate = windowFrom(now)
  const today = now.toISOString().slice(0, 10)

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

      // Explicit user-authored rules: authoritative, listed separately from
      // observed patterns (instruction vs observation).
      supabase
        .from('mapping_rules')
        .select('rule_name, merchant_pattern, description_pattern, debit_account, vat_treatment')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('priority', { ascending: true })
        .limit(25),

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

  const explicitRules: ExplicitRule[] = (rulesRes.data ?? [])
    .map((r) => ({
      rule_name: r.rule_name,
      match: r.merchant_pattern ?? r.description_pattern ?? '',
      account_number: r.debit_account,
      vat_treatment: r.vat_treatment,
      source: 'mapping_rule' as const,
    }))
    .filter((r) => r.match !== '')
    .slice(0, MAX_EXPLICIT_RULES)

  const voucherSeries = [
    ...new Set((voucherSeriesRes.data ?? []).map((v) => v.voucher_series as string)),
  ].sort()

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
      treatments_used_12m: stats.vat_treatments_used ?? [],
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
