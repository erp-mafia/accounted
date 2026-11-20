import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fillRegisteredOfficeFromRegistry } from '@/lib/company/registered-office'

/**
 * The annual report page holds its first paint for this answer, so the
 * register gets less time here than at company creation. A register that
 * has not answered by then counts as having no answer: the page asks again
 * on the next visit.
 */
const REGISTER_ANSWER_DEADLINE_MS = 3_000

/**
 * POST /api/settings/registered-office/from-register: asks the register for
 * the company's säte when it has none, and stores the answer. The annual
 * report page calls it once when the report it loaded has no säte, so a
 * company created before company creation asked the register gets its säte
 * without anyone typing it.
 *
 * Never replaces a stored säte, and answers 200 with what happened
 * (`present`, `filled`, `not_found`, `not_saved`): the register having no
 * answer is an outcome here, not an error. Owner and admin only, like every
 * write to company_settings.
 */
export const POST = withRouteContext(
  'settings.registered_office_from_register',
  async (_request, { supabase, companyId, log }) => {
    const fill = await fillRegisteredOfficeFromRegistry(supabase, companyId, {
      deadlineMs: REGISTER_ANSWER_DEADLINE_MS,
    })
    if (fill.status !== 'present') log.info('registered office asked from the register', { status: fill.status })
    return NextResponse.json({ data: fill })
  },
  { requireAdmin: true },
)
