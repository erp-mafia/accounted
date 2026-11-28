import type { SupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId, type ActiveCompanyFacts } from '@/lib/company/active-company'
import { DEFAULT_START_PAGE, startPageFor, storedStartPages, type StartPagePath } from '@/lib/company/start-page'
import { isBookingScreenEnabled } from '@/lib/env/booking-screen-switch'
import { createLogger } from '@/lib/logger'

const log = createLogger('company/start-page')

/**
 * The person's start page in a company (lib/company/start-page.ts): `companyId`
 * when the caller just made it the active one (the company switch), else the
 * active company. Their stored choice when their role there can open it, else
 * '/'. Any failed read answers '/': the start page is a convenience, never a
 * gate, and the pages check the role themselves.
 */
export async function resolveStartPath(
  supabase: SupabaseClient,
  userId: string,
  companyId?: string,
): Promise<StartPagePath> {
  try {
    // The choice first: most people have none, and then nothing else is read.
    const prefs = await supabase.from('user_preferences').select('ui_state').eq('user_id', userId).maybeSingle()
    if (prefs.error) return '/'
    const choices = storedStartPages(
      (prefs.data as { ui_state?: { start_page?: unknown } } | null)?.ui_state?.start_page,
    )
    if (Object.keys(choices).length === 0) return '/'

    const facts: ActiveCompanyFacts = {}
    const activeCompanyId = companyId ?? (await getActiveCompanyId(supabase, userId, facts))
    const choice = activeCompanyId ? choices[activeCompanyId] : undefined
    if (!activeCompanyId || !choice || choice === DEFAULT_START_PAGE.id) return '/'

    let role: string | null = facts.role ?? null
    if (!role) {
      const { data, error } = await supabase
        .from('company_members')
        .select('role')
        .eq('company_id', activeCompanyId)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) return '/'
      role = (data as { role?: string } | null)?.role ?? null
    }

    return startPageFor(choices, activeCompanyId, {
      role,
      bookingScreenEnabled: isBookingScreenEnabled(activeCompanyId),
    }).path
  } catch (err) {
    log.error('start page resolution failed', err as Error)
    return '/'
  }
}
