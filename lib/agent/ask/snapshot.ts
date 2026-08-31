import type { SupabaseClient } from '@supabase/supabase-js'
import { getDeadlinesNeedingAttention } from '@/lib/deadlines/status-engine'

/**
 * A compact, always-on grounding block for the single-call assistant.
 *
 * This is the reliability backstop for the "MCP tools + snapshot" design: it
 * lets a model that does NOT call tools (a weaker local model, or one whose
 * function-calling is off) still answer the standing-status questions from
 * this block alone. It carries the company's standing profile and the
 * deadlines that need attention: it deliberately does NOT carry figures
 * (result, expenses, VAT amounts, transactions), which come from the read
 * tools so they are always live and never stale in a prompt.
 *
 * Company-scoped: reads only this company's own rows. Every part is
 * best-effort: a slow or failing query drops that line, never the answer.
 */

function accountingMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null
  const m = method.toLowerCase()
  if (m.includes('cash') || m.includes('kontant')) return 'kontantmetod'
  if (m.includes('accrual') || m.includes('faktura')) return 'fakturametod'
  return method
}

export async function buildAssistantSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const lines: string[] = []

  try {
    const { data } = await supabase
      .from('company_settings')
      .select('vat_registered, moms_period, accounting_method, pays_salaries')
      .eq('company_id', companyId)
      .maybeSingle()
    const row = data as {
      vat_registered?: boolean | null
      moms_period?: string | null
      accounting_method?: string | null
      pays_salaries?: boolean | null
    } | null
    if (row) {
      const parts: string[] = []
      parts.push(
        row.vat_registered
          ? `momsregistrerad${row.moms_period ? ` (momsperiod: ${row.moms_period})` : ''}`
          : 'ej momsregistrerad',
      )
      const method = accountingMethodLabel(row.accounting_method)
      if (method) parts.push(`bokföringsmetod: ${method}`)
      parts.push(row.pays_salaries ? 'betalar löner' : 'betalar inte löner')
      lines.push(`Status: ${parts.join(', ')}.`)
    }
  } catch {
    // best-effort: skip the status line
  }

  try {
    const { overdue, actionNeeded } = await getDeadlinesNeedingAttention(supabase, companyId)
    const soon = [...overdue, ...actionNeeded].slice(0, 6)
    if (soon.length > 0) {
      lines.push(
        `Deadlines som behöver åtgärd: ${soon
          .map((d) => `${d.title} (${d.due_date})`)
          .join('; ')}.`,
      )
    }
  } catch {
    // best-effort: skip the deadlines line
  }

  return lines.join('\n')
}
