import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getLedgerMode, canPublishToHosted } from '@/lib/obx/ledger-mode'
import { runPublishChecklist } from '@/lib/obx/publish-checklist'
import { publishYearSealToHosted } from '@/lib/obx/publish-to-hosted'

const publishBodySchema = z.object({
  fiscal_year: z.number().int().min(1990).max(2100),
  passphrase: z.string().min(4).optional(),
  approval_method: z.enum(['passphrase', 'bankid']).optional(),
  include_documents: z.boolean().optional(),
  hosted_company_id: z.string().uuid().optional(),
})

export const GET = withRouteContext('obx.publish.checklist', async (request, ctx) => {
  const { supabase, companyId } = ctx
  try {
    const url = new URL(request.url)
    const yearRaw = url.searchParams.get('fiscal_year')
    const fiscalYear = yearRaw ? Number.parseInt(yearRaw, 10) : new Date().getFullYear()
    if (!Number.isFinite(fiscalYear)) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: [{ field: 'fiscal_year', message: 'Invalid fiscal year' }] },
      })
    }

    const checklist = await runPublishChecklist(supabase, companyId, fiscalYear)
    return NextResponse.json({
      data: {
        ...checklist,
        publish_configured: canPublishToHosted(),
        ledger_mode: getLedgerMode(),
      },
    })
  } catch (err) {
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})

export const POST = withRouteContext(
  'obx.publish',
  async (request, ctx) => {
    const { supabase, companyId, user } = ctx
    try {
      if (getLedgerMode() !== 'hybrid') {
        return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: [
              {
                field: 'OMBRA_LEDGER_MODE',
                message: 'Publish requires OMBRA_LEDGER_MODE=hybrid',
              },
            ],
          },
        })
      }

      const json = await request.json()
      const parsed = publishBodySchema.safeParse(json)
      if (!parsed.success) {
        return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: parsed.error.issues },
        })
      }

      const result = await publishYearSealToHosted(supabase, {
        companyId,
        userId: user.id,
        fiscalYear: parsed.data.fiscal_year,
        passphrase: parsed.data.passphrase,
        approvalMethod: parsed.data.approval_method ?? 'passphrase',
        includeDocuments: parsed.data.include_documents ?? true,
        hostedCompanyId: parsed.data.hosted_company_id,
      })

      if (!result.ok) {
        return NextResponse.json(
          {
            error: {
              code: 'PUBLISH_FAILED',
              message: result.error ?? 'Publish failed',
              checklist: result.checklist,
              hosted_status: result.hosted_status,
              hosted_body: result.hosted_body,
            },
          },
          { status: 400 },
        )
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireWrite: true },
)
