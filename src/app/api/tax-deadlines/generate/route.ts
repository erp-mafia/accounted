import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  DEADLINE_SETTINGS_SELECT,
  regenerateTaxDeadlinesForUser,
  toDeadlineSettings,
} from '@/lib/tax/deadline-generator'

/**
 * POST /api/tax-deadlines/generate
 * Manually trigger tax deadline generation for the current user
 */
export const POST = withRouteContext(
  'tax_deadlines.generate',
  async (_request, ctx) => {
    const { supabase, companyId, log } = ctx

    // Fetch company settings
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select(DEADLINE_SETTINGS_SELECT)
      .eq('company_id', companyId)
      .single()

    if (settingsError || !settings) {
      return NextResponse.json(
        { error: 'Company settings not found' },
        { status: 404 }
      )
    }

    try {
      const result = await regenerateTaxDeadlinesForUser(
        supabase,
        companyId,
        toDeadlineSettings(settings),
      )

      return NextResponse.json({
        success: true,
        created: result.created,
        deleted: result.deleted,
      })
    } catch (error) {
      log.error('tax deadline generation failed', error as Error)
      return NextResponse.json(
        { error: 'Failed to generate tax deadlines' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true },
)
