import type { McpResource } from './types'
import { ACTION_NEEDED_THRESHOLD_DAYS } from '@/lib/deadlines/status-engine'

type Severity = 'critical' | 'warning' | 'info'

interface AttentionCategory {
  key: string
  label_sv: string
  severity: Severity
  count: number
  samples: Array<Record<string, unknown>>
  next?: {
    description: string
    tool?: string
    args?: Record<string, unknown>
    resource?: string
  }
}

const SAMPLE_LIMIT = 5

function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  return Math.round(ms / 86_400_000)
}

export const attentionResource: McpResource = {
  uri: 'Accounted://attention',
  name: 'What Needs Attention',
  description:
    'One-shot summary of outstanding work for the active company: unbooked transactions, overdue invoices, pending approvals, voucher gaps, upcoming deadlines, bank consent expiry, and period-lock alerts. Each category includes a count, up to 5 sample rows, and a suggested next tool call. Use this at session start to orient before chaining read tools.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const horizonDate = new Date(now.getTime() + ACTION_NEEDED_THRESHOLD_DAYS * 86_400_000)
    const horizon = horizonDate.toISOString().slice(0, 10)

    const [
      unbookedHead,
      unbookedSamples,
      overdueRows,
      pendingSupplierHead,
      pendingSupplierSamples,
      pendingOpsHead,
      pendingOpsSamples,
      unmatchedReceiptsHead,
      unmatchedReceiptsSamples,
      voucherSeriesRows,
      deadlineRows,
      bankConnRows,
      activePeriodRow,
      companySettingsRow,
    ] = await Promise.all([
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_business', true),
      supabase
        .from('transactions')
        .select('id, date, amount, currency, description, merchant_name')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_business', true)
        .order('date', { ascending: true })
        .limit(SAMPLE_LIMIT),
      supabase
        .from('invoices')
        .select('id, invoice_number, customer_id, due_date, total, currency, status')
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue'])
        .lt('due_date', today)
        .order('due_date', { ascending: true })
        .limit(100),
      supabase
        .from('supplier_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'registered'),
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, supplier_id, total, currency, due_date')
        .eq('company_id', companyId)
        .eq('status', 'registered')
        .order('due_date', { ascending: true })
        .limit(SAMPLE_LIMIT),
      supabase
        .from('pending_operations')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'pending'),
      supabase
        .from('pending_operations')
        .select('id, operation_type, title, risk_level, actor_label, created_at')
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(SAMPLE_LIMIT),
      supabase
        .from('receipts')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'confirmed')
        .is('matched_transaction_id', null),
      supabase
        .from('receipts')
        .select('id, receipt_date, total_amount, currency, merchant_name')
        .eq('company_id', companyId)
        .eq('status', 'confirmed')
        .is('matched_transaction_id', null)
        .order('receipt_date', { ascending: false, nullsFirst: false })
        .limit(SAMPLE_LIMIT),
      supabase
        .from('voucher_sequences')
        .select('voucher_series, fiscal_period_id')
        .eq('company_id', companyId),
      supabase
        .from('deadlines')
        .select('id, title, due_date, deadline_type, tax_deadline_type, status')
        .eq('company_id', companyId)
        .eq('is_completed', false)
        .lte('due_date', horizon)
        .order('due_date', { ascending: true })
        .limit(20),
      supabase
        .from('bank_connections')
        .select('id, bank_name, status, consent_expires')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .not('consent_expires', 'is', null),
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, locked_at, is_closed')
        .eq('company_id', companyId)
        .lte('period_start', today)
        .gte('period_end', today)
        .maybeSingle(),
      supabase
        .from('company_settings')
        .select('bookkeeping_locked_through, auto_lock_period_days')
        .eq('company_id', companyId)
        .maybeSingle(),
    ])

    const categories: AttentionCategory[] = []

    // ── Unbooked business transactions ──────────────────────────────
    const unbookedCount = unbookedHead.count ?? 0
    if (unbookedCount > 0) {
      const oldest = unbookedSamples.data?.[0]
      const oldestAgeDays = oldest?.date ? daysBetween(oldest.date, today) : 0
      categories.push({
        key: 'unbooked_transactions',
        label_sv: 'Obokförda affärstransaktioner',
        severity: oldestAgeDays > 30 ? 'critical' : 'warning',
        count: unbookedCount,
        samples: unbookedSamples.data ?? [],
        next: {
          description: 'Kategorisera den äldsta obokförda transaktionen.',
          tool: 'gnubok_categorize_transaction',
          args: oldest ? { transaction_id: oldest.id } : undefined,
        },
      })
    }

    // ── Overdue invoices ────────────────────────────────────────────
    const overdueAll = overdueRows.data ?? []
    if (overdueAll.length > 0) {
      const maxOverdueDays = overdueAll.reduce((max, inv) => {
        const days = inv.due_date ? daysBetween(inv.due_date, today) : 0
        return Math.max(max, days)
      }, 0)
      categories.push({
        key: 'overdue_invoices',
        label_sv: 'Förfallna fakturor',
        severity: maxOverdueDays > 30 ? 'critical' : 'warning',
        count: overdueAll.length,
        samples: overdueAll.slice(0, SAMPLE_LIMIT),
        next: {
          description: 'Granska förfallna fakturor och skicka påminnelser.',
          resource: 'Accounted://recent-activity?limit=20',
        },
      })
    }

    // ── Pending supplier invoices (status='registered') ─────────────
    const pendingSupplierCount = pendingSupplierHead.count ?? 0
    if (pendingSupplierCount > 0) {
      const oldestRegistered = pendingSupplierSamples.data?.[0]
      categories.push({
        key: 'pending_supplier_invoices',
        label_sv: 'Leverantörsfakturor som väntar på godkännande',
        severity: 'warning',
        count: pendingSupplierCount,
        samples: pendingSupplierSamples.data ?? [],
        next: {
          description: 'Godkänn äldsta registrerade leverantörsfakturan.',
          tool: 'gnubok_approve_supplier_invoice',
          args: oldestRegistered ? { supplier_invoice_id: oldestRegistered.id } : undefined,
        },
      })
    }

    // ── Pending operations awaiting approval ────────────────────────
    const pendingOpsCount = pendingOpsHead.count ?? 0
    if (pendingOpsCount > 0) {
      const ops = pendingOpsSamples.data ?? []
      const hasHighRisk = ops.some((o) => o.risk_level === 'high')
      categories.push({
        key: 'pending_operations',
        label_sv: 'Operationer som väntar på godkännande',
        severity: hasHighRisk ? 'critical' : 'warning',
        count: pendingOpsCount,
        samples: ops,
        next: {
          description:
            'Visa kön för användaren. När användaren godkänner en specifik operation_id i chatten, anropa gnubok_approve_pending_operation direkt: /pending är ett alternativ, inte ett krav.',
          tool: 'gnubok_list_pending_operations',
        },
      })
    }

    // ── Unmatched receipts ──────────────────────────────────────────
    const unmatchedReceiptsCount = unmatchedReceiptsHead.count ?? 0
    if (unmatchedReceiptsCount > 0) {
      const samples = unmatchedReceiptsSamples.data ?? []
      const oldest = samples[samples.length - 1]
      categories.push({
        key: 'unmatched_receipts',
        label_sv: 'Kvitton utan matchad transaktion',
        severity: 'warning',
        count: unmatchedReceiptsCount,
        samples,
        next: {
          description: 'Försök matcha kvitto mot bankhändelse.',
          tool: 'gnubok_receipt_matcher',
          args: oldest ? { receipt_id: oldest.id } : undefined,
        },
      })
    }

    // ── Voucher gaps without explanations ──────────────────────────
    const seriesRows = (voucherSeriesRows.data ?? []) as Array<{ voucher_series: string; fiscal_period_id: string }>
    const allGaps: Array<{ series: string; gap_start: number; gap_end: number; fiscal_period_id: string }> = []
    for (const row of seriesRows) {
      const { data: gaps } = await supabase.rpc('detect_voucher_gaps', {
        p_company_id: companyId,
        p_fiscal_period_id: row.fiscal_period_id,
        p_series: row.voucher_series,
      })
      if (gaps && Array.isArray(gaps)) {
        for (const g of gaps as Array<{ gap_start: number; gap_end: number }>) {
          allGaps.push({
            series: row.voucher_series,
            gap_start: g.gap_start,
            gap_end: g.gap_end,
            fiscal_period_id: row.fiscal_period_id,
          })
        }
      }
    }
    if (allGaps.length > 0) {
      const { data: explanations } = await supabase
        .from('voucher_gap_explanations')
        .select('voucher_series, gap_start, gap_end, fiscal_period_id')
        .eq('company_id', companyId)
      const explainedKeys = new Set(
        (explanations ?? []).map(
          (e) => `${e.fiscal_period_id}:${e.voucher_series}:${e.gap_start}:${e.gap_end}`
        )
      )
      const unexplained = allGaps.filter(
        (g) => !explainedKeys.has(`${g.fiscal_period_id}:${g.series}:${g.gap_start}:${g.gap_end}`)
      )
      if (unexplained.length > 0) {
        const first = unexplained[0]
        categories.push({
          key: 'voucher_gaps_unexplained',
          label_sv: 'Verifikationshål utan förklaring (BFNAR 2013:2)',
          severity: 'critical',
          count: unexplained.length,
          samples: unexplained.slice(0, SAMPLE_LIMIT),
          next: {
            description: 'Dokumentera hålet i verifikationsserien.',
            tool: 'gnubok_explain_voucher_gap',
            args: first
              ? {
                  fiscal_period_id: first.fiscal_period_id,
                  voucher_series: first.series,
                  gap_start: first.gap_start,
                  gap_end: first.gap_end,
                }
              : undefined,
          },
        })
      }
    }

    // ── Deadlines upcoming (within 14 days) ─────────────────────────
    const deadlines = deadlineRows.data ?? []
    if (deadlines.length > 0) {
      const anyOverdue = deadlines.some((d) => d.due_date && d.due_date < today)
      categories.push({
        key: 'deadlines_upcoming',
        label_sv: 'Deadlines inom 14 dagar',
        severity: anyOverdue ? 'critical' : 'warning',
        count: deadlines.length,
        samples: deadlines.slice(0, SAMPLE_LIMIT),
        next: {
          description: 'Granska kommande deadlines i /deadlines.',
        },
      })
    }

    // ── Bank consent expiring ───────────────────────────────────────
    const bankConns = bankConnRows.data ?? []
    const expiring = bankConns
      .map((c) => {
        const daysLeft = c.consent_expires ? daysBetween(today, c.consent_expires) : null
        return { ...c, days_left: daysLeft }
      })
      .filter((c) => c.days_left != null && c.days_left <= ACTION_NEEDED_THRESHOLD_DAYS)
    if (expiring.length > 0) {
      const anyExpired = expiring.some((c) => (c.days_left ?? 0) <= 0)
      categories.push({
        key: 'bank_consent_expiring',
        label_sv: 'Bankanslutningar med samtycke som löper ut',
        severity: anyExpired ? 'critical' : 'warning',
        count: expiring.length,
        samples: expiring.slice(0, SAMPLE_LIMIT).map((c) => ({
          id: c.id,
          bank_name: c.bank_name,
          consent_expires: c.consent_expires,
          days_left: c.days_left,
        })),
        next: {
          description: 'Be användaren förnya bank-samtycket innan det löper ut.',
        },
      })
    }

    // ── Period lock approaching ─────────────────────────────────────
    const lockDate = companySettingsRow.data?.bookkeeping_locked_through ?? null
    if (lockDate && activePeriodRow.data) {
      const daysUntilLock = daysBetween(today, lockDate)
      if (daysUntilLock >= 0 && daysUntilLock <= ACTION_NEEDED_THRESHOLD_DAYS) {
        categories.push({
          key: 'period_lock_approaching',
          label_sv: 'Bokföringslås närmar sig',
          severity: 'info',
          count: 1,
          samples: [
            {
              lock_date: lockDate,
              days_until: daysUntilLock,
              active_period_id: activePeriodRow.data.id,
            },
          ],
          next: {
            description: 'Slutför obokfört arbete innan lock_date.',
            resource: 'Accounted://period/active',
          },
        })
      }
    }

    // ── Summary tally ───────────────────────────────────────────────
    const summary = {
      total_items: categories.reduce((sum, c) => sum + c.count, 0),
      critical: categories.filter((c) => c.severity === 'critical').length,
      warning: categories.filter((c) => c.severity === 'warning').length,
      info: categories.filter((c) => c.severity === 'info').length,
    }

    return {
      generated_at: now.toISOString(),
      summary,
      categories,
    }
  },
}
