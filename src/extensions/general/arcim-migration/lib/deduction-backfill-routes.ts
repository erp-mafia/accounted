import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition } from '@/lib/extensions/types'
import { validateBody } from '@/lib/api/validate'
import { requireWritePermission } from '@/lib/auth/require-write'
import { createLogger } from '@/lib/logger'
import {
  hasVismaInvoiceSource,
  isProviderImportRunning,
  runDeductionBackfill,
  type DeductionBackfillRefusal,
} from './deduction-backfill'

const RunSchema = z.object({ mode: z.enum(['preview', 'apply']) }).strict()

// The runner hands its logger to the chart-of-accounts service, which takes a
// full Logger; the dispatcher's ExtensionLogger has no child().
const log = createLogger('ext:arcim-migration:deduction-backfill')

/**
 * Under the dispatcher's 800 s ceiling with room to answer. A run that hits
 * it stops cleanly and reports progress; running it again continues.
 */
const RUN_BUDGET_MS = 600_000

const REFUSALS: Record<DeductionBackfillRefusal, { status: number; message: string; message_en: string }> = {
  NOT_APPLICABLE: {
    status: 404,
    message: 'Företaget har inga fakturor flyttade från Visma.',
    message_en: 'The company has no invoices moved from Visma.',
  },
  IMPORT_RUNNING: {
    status: 409,
    message: 'Flytten från Visma pågår fortfarande. Vänta tills den är klar och försök igen.',
    message_en: 'The move from Visma is still running. Wait until it has finished and try again.',
  },
  RECONNECT_REQUIRED: {
    status: 409,
    message: 'Anslut Visma igen för att hämta fakturornas uppgifter.',
    message_en: 'Connect Visma again to fetch the invoice details.',
  },
  DIFFERENT_COMPANY: {
    status: 409,
    message: 'Visma-anslutningen gäller ett annat företag än det som flyttades hit.',
    message_en: 'The Visma connection is for a different company than the one moved here.',
  },
}

function failure() {
  return NextResponse.json(
    {
      error: {
        code: 'MIGRATED_DEDUCTION_FAILED',
        message: 'Skattereduktionerna kunde inte hämtas. Inget har ändrats som inte redan var klart, försök igen.',
        message_en: 'The tax deductions could not be fetched. Nothing that was not already done has changed, try again.',
      },
    },
    { status: 500 },
  )
}

/**
 * The post-migration ROT/RUT step (lib/deduction-backfill.ts). The extension
 * dispatcher enforces sign-in, MFA and company membership; both POST modes
 * also need write access: the preview uses the company's Visma connection,
 * and apply books vouchers.
 */
export const deductionBackfillRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/deduction-backfill',
    handler: async (_request, ctx) => {
      try {
        const applicable = await hasVismaInvoiceSource(ctx.supabase, ctx.companyId)
        const importRunning = applicable ? await isProviderImportRunning(ctx.supabase, ctx.companyId) : false
        return NextResponse.json({ data: { applicable, importRunning } }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) {
        ctx.log.error('deduction backfill status failed', error as Error)
        return failure()
      }
    },
  },
  {
    method: 'POST',
    path: '/deduction-backfill',
    requireWrite: true,
    handler: async (request, ctx) => {
      const body = await validateBody(request, RunSchema)
      if (!body.success) return body.response
      const write = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
      if (!write.ok) return write.response
      try {
        const result = await runDeductionBackfill(
          { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.userId, log },
          { mode: body.data.mode, budgetMs: RUN_BUDGET_MS },
        )
        if (!result.ok) {
          const refusal = REFUSALS[result.code]
          return NextResponse.json(
            { error: { code: `MIGRATED_DEDUCTION_${result.code}`, message: refusal.message, message_en: refusal.message_en } },
            { status: refusal.status },
          )
        }
        return NextResponse.json({ data: result.report })
      } catch (error) {
        ctx.log.error('deduction backfill run failed', error as Error, { mode: body.data.mode })
        return failure()
      }
    },
  },
]
