import type { McpResource } from './types'
import { TOOL_SCOPE_MAP, hasScope } from '@/lib/auth/api-keys'

interface Capability {
  tool: string
  scope: string
  granted: boolean
  state_blocked: boolean
  reason: string | null
}

export const capabilitiesResource: McpResource = {
  uri: 'Accounted://capabilities',
  name: 'Capabilities',
  description: 'What the current API key can actually do given (a) its granted scopes and (b) the current company state. Surfaces blockers like locked periods so the agent knows ahead of time why an action would fail.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId, scopes }) => {
    const today = new Date().toISOString().slice(0, 10)

    const { data: activePeriod } = await supabase
      .from('fiscal_periods')
      .select('id, is_closed, locked_at, opening_balances_set, period_end')
      .eq('company_id', companyId)
      .lte('period_start', today)
      .gte('period_end', today)
      .maybeSingle()

    const { data: settings } = await supabase
      .from('company_settings')
      .select('bookkeeping_locked_through, vat_registered, pays_salaries')
      .eq('company_id', companyId)
      .maybeSingle()

    const periodIsLocked = !!activePeriod?.locked_at || !!activePeriod?.is_closed
    const periodMissing = !activePeriod
    const companyLocked = !!settings?.bookkeeping_locked_through
      && settings.bookkeeping_locked_through >= today

    const stateBlockers: Record<string, string | null> = {
      // Scope → reason it's blocked by current state, or null
      'transactions:write': periodMissing
        ? 'No fiscal period covers today\'s date: open a period first'
        : periodIsLocked
          ? 'Active period is closed/locked'
          : companyLocked
            ? 'Company-wide bookkeeping lock is in effect'
            : null,
      'invoices:write': periodMissing ? 'No fiscal period covers today\'s date' : null,
      'payroll:write': !settings?.pays_salaries
        ? 'Company is not configured to pay salaries (settings.pays_salaries=false)'
        : null,
    }

    const capabilities: Capability[] = Object.entries(TOOL_SCOPE_MAP).map(
      ([tool, scope]) => {
        const granted = hasScope(scopes, scope)
        const stateReason = stateBlockers[scope] ?? null
        return {
          tool,
          scope,
          granted,
          state_blocked: granted && !!stateReason,
          reason: !granted
            ? `Scope "${scope}" not granted to this API key`
            : stateReason,
        }
      }
    )

    return {
      granted_scopes: scopes,
      active_period: activePeriod ?? null,
      company_lock_date: settings?.bookkeeping_locked_through ?? null,
      vat_registered: settings?.vat_registered ?? false,
      pays_salaries: settings?.pays_salaries ?? false,
      capabilities,
      summary: {
        total: capabilities.length,
        granted: capabilities.filter((c) => c.granted).length,
        state_blocked: capabilities.filter((c) => c.state_blocked).length,
      },
    }
  },
}
