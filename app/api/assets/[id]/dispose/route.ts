import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { disposeAsset } from '@/lib/bokslut/assets/asset-service'

const VAT_TREATMENTS = [
  'standard_25',
  'reverse_charge',
  'export',
  'exempt',
] as const

const DisposeAssetSchema = z
  .object({
    disposal_type: z.enum(['sale', 'scrap', 'business_transfer']),
    disposed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    disposed_proceeds: z.number().nonnegative(),
    proceeds_account: z.string().regex(/^\d{4}$/).optional(),
    fiscal_period_id: z.string().uuid(),
    vat_treatment: z.enum(VAT_TREATMENTS).optional(),
    jamkning_original_input_vat: z.number().nonnegative().optional(),
    jamkning_original_deduction_percent: z.number().min(0).max(100).optional(),
    business_transfer_confirmed: z.boolean().optional(),
    adjustment_document_confirmed: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.disposal_type === 'scrap' && value.disposed_proceeds !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposed_proceeds'],
        message: 'disposed_proceeds måste vara 0 vid utrangering.',
      })
    }
    if (value.disposal_type === 'sale' && value.disposed_proceeds > 0 && !value.vat_treatment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vat_treatment'],
        message: 'vat_treatment krävs vid försäljning.',
      })
    }
    if (value.disposal_type !== 'sale' && value.vat_treatment !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vat_treatment'],
        message: 'vat_treatment får bara anges vid försäljning.',
      })
    }
    const hasVat = value.jamkning_original_input_vat !== undefined
    const hasPercent = value.jamkning_original_deduction_percent !== undefined
    if (hasVat !== hasPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasVat
          ? ['jamkning_original_deduction_percent']
          : ['jamkning_original_input_vat'],
        message: 'Ursprungsmoms och ursprunglig avdragsprocent måste anges tillsammans.',
      })
    }
  })

export const POST = withRouteContext(
  'assets.dispose',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, DisposeAssetSchema)
    if (!validation.success) return validation.response
    try {
      const result = await disposeAsset(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
