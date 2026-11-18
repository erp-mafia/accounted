import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Accounted's own reminders never run beside the collections provider's
 * (build spec 3.5, product decision 2026-10-03: the provider runs the whole
 * ladder). An Accounted-side reminder sender must skip an invoice with an
 * open case, and every invoice of a company whose collections connection is
 * active, so it can never send a reminder, or book a reminder fee, on an
 * invoice the provider is pursuing or is about to be given. The old dormant
 * sender (lib/invoices/reminder-processor.ts) was removed in Plan 2 step 18;
 * this guard stays for whichever sender comes next.
 */
export interface ReminderExclusions {
  /** Companies with an active collections connection. */
  companies: ReadonlySet<string>
  /** Invoices with an open collection case. */
  invoices: ReadonlySet<string>
}

export async function loadReminderExclusions(
  db: Pick<SupabaseClient, 'from'>,
  candidates: ReadonlyArray<{ id: string; company_id: string }>,
): Promise<ReminderExclusions> {
  const companies = new Set<string>()
  const invoices = new Set<string>()
  if (candidates.length === 0) return { companies, invoices }
  // Open cases are read per company, not per invoice: the run can hold a
  // thousand invoices, far fewer companies. Chunked so no query string grows
  // past what PostgREST's gateway accepts.
  const companyIds = [...new Set(candidates.map((c) => c.company_id))]
  for (let i = 0; i < companyIds.length; i += GUARD_LOOKUP_CHUNK) {
    const chunk = companyIds.slice(i, i + GUARD_LOOKUP_CHUNK)
    // Fail closed: if we cannot tell, nobody gets a reminder this run (both reads throw).
    const [connections, cases] = await Promise.all([
      fetchAllRows<{ company_id: string }>(({ from, to }) =>
        db.from('collection_connections').select('company_id').in('company_id', chunk).eq('state', 'active').order('id').range(from, to),
      ),
      fetchAllRows<{ invoice_id: string }>(({ from, to }) =>
        db.from('collection_cases').select('invoice_id').in('company_id', chunk).eq('is_open', true).order('id').range(from, to),
      ),
    ])
    for (const r of connections) companies.add(r.company_id)
    for (const r of cases) invoices.add(r.invoice_id)
  }
  return { companies, invoices }
}

/** Company ids per lookup. */
const GUARD_LOOKUP_CHUNK = 100

export function isReminderExcluded(exclusions: ReminderExclusions, invoice: { id: string; company_id: string }): boolean {
  return exclusions.companies.has(invoice.company_id) || exclusions.invoices.has(invoice.id)
}
