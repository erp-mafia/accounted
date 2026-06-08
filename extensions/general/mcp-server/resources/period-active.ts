import type { McpResource } from './types'

export const periodActiveResource: McpResource = {
  uri: 'Accounted://period/active',
  name: 'Active Fiscal Period',
  description: 'The fiscal period that the current date falls within: lock state, opening-balance status, retention deadline. Use to check whether new entries can be posted.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    const today = new Date().toISOString().slice(0, 10)

    const { data: active, error: activeError } = await supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, closed_at, locked_at, opening_balances_set, retention_expires_at, opening_balance_entry_id, closing_entry_id, previous_period_id')
      .eq('company_id', companyId)
      .lte('period_start', today)
      .gte('period_end', today)
      .maybeSingle()

    if (activeError && activeError.code !== 'PGRST116') {
      throw new Error(`Failed to read active period: ${activeError.message}`)
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('bookkeeping_locked_through, auto_lock_period_days')
      .eq('company_id', companyId)
      .maybeSingle()

    const periodLockedAt = active?.locked_at ?? null
    const isClosed = active?.is_closed ?? null
    const companyLockDate = settings?.bookkeeping_locked_through ?? null

    const canPostEntries = active
      ? !isClosed && !periodLockedAt
      : false

    return {
      active_period: active ?? null,
      company_lock: {
        bookkeeping_locked_through: companyLockDate,
        auto_lock_period_days: settings?.auto_lock_period_days ?? null,
      },
      can_post_entries: canPostEntries,
      reason_blocked: !active
        ? 'No fiscal period covers today\'s date'
        : isClosed
          ? 'Active period is closed (status: stängd)'
          : periodLockedAt
            ? 'Active period is locked (status: låst)'
            : null,
    }
  },
}
