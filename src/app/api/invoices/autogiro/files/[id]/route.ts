import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { encodeAutogiroFile } from '@/lib/invoices/autogiro/writer'
import { loadStoredFile } from '@/lib/invoices/autogiro/service'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * GET /api/invoices/autogiro/files/[id]: downloads a stored Autogiro file
 * (a debit or cancellation file for the bank, or a report read) as the
 * ISO 8859-1 text Bankgirot reads. Mandate reports and answers carry
 * personal data and are never stored.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'autogiro.file.download',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    const result = await loadStoredFile(supabase, companyId, parsed.data.id)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    const filename = result.filename.replace(/[^\w.-]/g, '_')
    return new Response(new Uint8Array(encodeAutogiroFile(result.content)), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=ISO-8859-1',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  },
)
