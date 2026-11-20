import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import { DIRECT_BOOKING_ON, type DirectBookingSettings } from './direct-booking'

const log = createLogger('transactions/direct-booking-settings')

/**
 * The company's one-click switch, company_settings.direct_booking_enabled,
 * as every surface that applies the direct-booking policy reads it.
 *
 * A company without a settings row, and a database the migration has not
 * reached yet (the code is live a few minutes before it runs), has the
 * column's default: on. Any other failure answers off, so a failed read
 * makes a booking ask once more than it had to, never once less.
 */
export async function readDirectBookingSettings(supabase: SupabaseClient, companyId: string): Promise<DirectBookingSettings> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('direct_booking_enabled')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    if (isMissingColumnError(error)) return DIRECT_BOOKING_ON
    log.warn('direct booking setting unreadable; every suggestion asks for a review', { companyId, error: error.message })
    return { enabled: false }
  }
  return { enabled: (data as { direct_booking_enabled?: boolean | null } | null)?.direct_booking_enabled !== false }
}
