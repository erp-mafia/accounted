import type { SupabaseClient } from '@supabase/supabase-js'
import { getDeadlinesNeedingAttention } from '@/lib/deadlines/status-engine'
import {
  loadActiveEmployeeCount,
  resolveEmployeeFacts,
  type EmployeeVerdict,
} from '@/lib/agent/composer/employee-facts'

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

/**
 * The salary part of the status line, or null when nothing is known.
 *
 * company_settings.pays_salaries is NOT NULL DEFAULT false and its only
 * writer is the Skatt settings form, so `false` is what every company that
 * never opened that form reads, whatever its ledger says. Stating "betalar
 * inte löner" from that default told a payroll-running aktiebolag in every
 * answer that it had no salaries (support case 2026-09-04). The same doctrine
 * as the composer (lib/agent/composer/employee-facts.ts): positive evidence
 * (active employees, the flag, an attested employer registration) yields the
 * fact, only an attested negative yields the negative, and the default
 * yields nothing.
 */
function salaryPart(verdict: EmployeeVerdict): string | null {
  switch (verdict.kind) {
    case 'count':
      return `betalar löner (${verdict.count} ${verdict.count === 1 ? 'anställd' : 'anställda'})`
    case 'employer':
      return verdict.isEmployer ? 'betalar löner' : 'betalar inte löner'
    default:
      return null
  }
}

export async function buildAssistantSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const lines: string[] = []

  try {
    const [{ data }, activeEmployees] = await Promise.all([
      supabase
        .from('company_settings')
        .select('vat_registered, moms_period, accounting_method, pays_salaries, employer_registered')
        .eq('company_id', companyId)
        .maybeSingle(),
      loadActiveEmployeeCount(supabase, companyId),
    ])
    const row = data as {
      vat_registered?: boolean | null
      moms_period?: string | null
      accounting_method?: string | null
      pays_salaries?: boolean | null
      employer_registered?: boolean | null
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
      const salary = salaryPart(
        resolveEmployeeFacts({
          activeEmployees,
          ticEmployeeRange: null,
          employerRegistered: row.employer_registered ?? null,
          paysSalaries: row.pays_salaries ?? null,
        }),
      )
      if (salary) parts.push(salary)
      lines.push(`Status: ${parts.join(', ')}.`)
      // So the model can point the user at the right page instead of
      // "inställningarna" in general when a value here is wrong.
      lines.push(
        'Grunduppgifterna ovan ändras under Inställningar > Skatt (moms, löner) och Inställningar > Bokföring (bokföringsmetod).',
      )
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
