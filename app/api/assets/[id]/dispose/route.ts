import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { disposeAsset } from '@/lib/bokslut/assets/asset-service'

const VAT_TREATMENTS = [
  'standard_25',
  'reduced_12',
  'reduced_6',
  'reverse_charge',
  'export',
  'exempt',
] as const

const DisposeAssetSchema = z
  .object({
    disposed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Gross proceeds (INCL VAT when applicable). */
    disposed_proceeds: z.number().nonnegative(),
    proceeds_account: z.string().regex(/^\d{4}$/).optional(),
    fiscal_period_id: z.string().uuid(),
    /** Output VAT on the proceeds. Defaults to 0 (sale was momsfri). */
    proceeds_vat: z.number().nonnegative().optional(),
    /** Required when proceeds_vat > 0 so the engine can resolve a 26xx account. */
    vat_treatment: z.enum(VAT_TREATMENTS).optional(),
    /** Precomputed jämkning amount (ML 8a kap 7 §). Caller supplies; engine
     *  books a 2641 credit + loss-account debit. */
    jamkning_amount: z.number().nonnegative().optional(),
    /** Audit metadata. */
    jamkning_remaining_months: z.number().int().nonnegative().optional(),
    jamkning_total_months: z.number().int().positive().optional(),
    jamkning_original_input_vat: z.number().nonnegative().optional(),
    // accumulated_depreciation is intentionally NOT accepted from the client —
    // disposeAsset sums depreciation_schedules server-side so callers cannot
    // inflate the book-value calculation.
  })
  .superRefine((value, ctx) => {
    // VAT consistency: if a treatment that produces a VAT line is selected,
    // the VAT amount must equal 25%/12%/6% of the net proceeds. Tolerance is
    // ±0.50 kr to handle rounding on item prices.
    if (value.proceeds_vat && value.proceeds_vat > 0) {
      if (!value.vat_treatment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vat_treatment'],
          message: 'vat_treatment krävs när proceeds_vat > 0.',
        })
        return
      }
      const rate = vatRateFromTreatment(value.vat_treatment)
      if (rate === null) {
        // Treatments without a VAT line must carry 0 VAT.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proceeds_vat'],
          message: `proceeds_vat måste vara 0 för momsbehandling "${value.vat_treatment}".`,
        })
        return
      }
      // Expected: proceeds_gross = net × (1 + rate), so net = gross / (1 + rate)
      // and vat = gross - net = gross × rate / (1 + rate).
      const expectedVat = (value.disposed_proceeds * rate) / (1 + rate)
      if (Math.abs(expectedVat - value.proceeds_vat) > 0.5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proceeds_vat'],
          message: `proceeds_vat ska vara ~${Math.round(expectedVat * 100) / 100} kr för momsbehandling "${value.vat_treatment}" på ${value.disposed_proceeds} kr brutto.`,
        })
      }
    }
  })

function vatRateFromTreatment(t: (typeof VAT_TREATMENTS)[number]): number | null {
  switch (t) {
    case 'standard_25':
      return 0.25
    case 'reduced_12':
      return 0.12
    case 'reduced_6':
      return 0.06
    case 'reverse_charge':
    case 'export':
    case 'exempt':
      return null
  }
}

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
