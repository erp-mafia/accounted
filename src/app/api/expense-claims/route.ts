import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateExpenseClaimSchema } from '@/lib/api/schemas'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  listExpenseClaims,
  registerExpenseClaim,
} from '@/lib/expenses/expense-claims-service'

ensureInitialized()

const REGISTER_ERROR_MESSAGES: Record<string, { message: string; status: number }> = {
  INVALID_LINES: {
    message: 'Verifikatraderna är ogiltiga: kontrollera att raderna balanserar och att skuldraden matchar beloppet.',
    status: 400,
  },
  EMPLOYEE_NOT_FOUND: { message: 'Anställd hittades inte', status: 404 },
  CLAIMANT_REQUIRED: {
    message: 'Ange vem utlägget avser: välj anställd eller skriv ett namn.',
    status: 400,
  },
  RATE_UNAVAILABLE: {
    message:
      'Ingen växelkurs kunde hämtas för datumet. Ange kursen manuellt och försök igen.',
    status: 400,
  },
  VAT_EXCEEDS_AMOUNT: { message: 'Momsen måste vara mindre än totalbeloppet.', status: 400 },
  FISCAL_PERIOD_NOT_FOUND: {
    message: 'Inget räkenskapsår täcker utläggsdatumet.',
    status: 400,
  },
  CLAIM_INSERT_FAILED: { message: 'Utlägget kunde inte sparas.', status: 500 },
}

export const GET = withRouteContext('expense_claims.list', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const claims = await listExpenseClaims(supabase, companyId, {
    status: status === 'registered' || status === 'paid' ? status : undefined,
  })
  return NextResponse.json({ data: claims })
})

export const POST = withRouteContext(
  'expense_claims.create',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, CreateExpenseClaimSchema)
    if (!validation.success) return validation.response

    try {
      const result = await registerExpenseClaim(supabase, companyId, user.id, {
        ...validation.data,
        employee_id: validation.data.employee_id ?? undefined,
        document_id: validation.data.document_id ?? undefined,
        inbox_item_id: validation.data.inbox_item_id ?? undefined,
      })
      if (!result.ok) {
        const mapped = REGISTER_ERROR_MESSAGES[result.code] ?? {
          message: 'Utlägget kunde inte registreras.',
          status: 500,
        }
        if (mapped.status >= 500) {
          log.error('expense claim registration failed', new Error(result.detail ?? result.code))
        }
        return NextResponse.json({ error: mapped.message, code: result.code }, { status: mapped.status })
      }
      return NextResponse.json({ data: result.claim }, { status: 201 })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      log.error('failed to register expense claim', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'journal_entry' }) },
        { status: 500 },
      )
    }
  },
  { requireWrite: true },
)
