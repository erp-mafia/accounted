import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withdrawDebitFile } from '@/lib/invoices/autogiro/service'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * POST /api/invoices/autogiro/debit-files/[id]/withdraw: the file's debits
 * become cancelled so the invoices can go into a new file, refused once
 * Bankgirot has reported on any of them. It does not stop a file already
 * uploaded in the bank (Autogiro Online does).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'autogiro.debit_file.withdraw',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    const result = await withdrawDebitFile(supabase, companyId, parsed.data.id)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    return NextResponse.json({ data: { cancelled: result.cancelled } })
  },
  { requireWrite: true },
)
