import type { McpResource } from './types'
import { TOOL_SCOPE_MAP, keyCanCallTool } from '@/lib/auth/api-keys'
import { resolveCompanyEntityType, UnknownEntityTypeError } from '@/lib/company/entity-type'
import { offersPayroll } from '@/lib/company/offers-payroll'

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
      .select('bookkeeping_locked_through, vat_registered, pays_salaries, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()

    // Same resolution as the dashboard layout: company_settings first, the
    // canonical companies row when it is missing. A missing or unknown form
    // leaves payroll to the pays_salaries flag alone; a failed companies read
    // propagates so the caller retries instead of seeing a wrong blocker.
    const entityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
      .catch((err: unknown) => {
        if (err instanceof UnknownEntityTypeError) return null
        throw err
      })

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
      // The dashboard's payroll rule: on by default for a juridisk person,
      // opt-in through pays_salaries for a personnummer-based form.
      'payroll:write': !offersPayroll(entityType, settings?.pays_salaries)
        ? 'Payroll is not turned on for this company (settings.pays_salaries=false; only a juridisk person has it by default)'
        : null,
    }

    const capabilities: Capability[] = Object.entries(TOOL_SCOPE_MAP).map(
      ([tool, scope]) => {
        // The tool's scope or one of its TOOL_ALTERNATIVE_SCOPES (a write key
        // may reject its own proposals without pending_operations:approve).
        const granted = keyCanCallTool(tool, scopes)
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
