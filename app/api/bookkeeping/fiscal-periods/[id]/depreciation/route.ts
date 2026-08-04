import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  proposeAnnualPostings,
  commitAnnualPostings,
} from '@/lib/bokslut/assets/depreciation-engine'
import {
  loadTaxDepreciationView,
  previewTaxDepreciationElection,
  saveTaxDepreciationElection,
  TaxDepreciationPeriodLockedError,
  TaxDepreciationValidationError,
} from '@/lib/bokslut/assets/tax-depreciation-service'

const CommitSchema = z.object({
  /** Optional whitelist: when supplied, only assets in this list are posted.
   *  Empty / omitted = post all proposed depreciations. */
  asset_ids: z.array(z.string().uuid()).optional(),
})

const TaxElectionSchema = z
  .object({
    method: z.enum(['rakenskapsenlig', 'restvarde']),
    selected_rule: z.enum(['huvudregel_30', 'kompletteringsregel_20']).optional(),
    opening_tax_value: z.number().nonnegative().optional(),
    elected_deduction: z.number().nonnegative(),
    book_conformity_confirmed: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method === 'rakenskapsenlig' && !value.selected_rule) {
      ctx.addIssue({
        code: 'custom',
        path: ['selected_rule'],
        message: 'Välj 30-procentsregeln eller 20-procentsregeln.',
      })
    }
    if (value.method === 'restvarde' && value.selected_rule) {
      ctx.addIssue({
        code: 'custom',
        path: ['selected_rule'],
        message: 'Restvärdeavskrivning har ingen kompletteringsregel.',
      })
    }
    if (value.method === 'rakenskapsenlig' && value.book_conformity_confirmed !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['book_conformity_confirmed'],
        message: 'Bekräfta att avdraget motsvarar bokslutets totala avskrivning.',
      })
    }
  })

const TaxPreviewQuerySchema = z
  .object({
    tax_method: z.enum(['rakenskapsenlig', 'restvarde']).optional(),
    tax_rule: z.enum(['huvudregel_30', 'kompletteringsregel_20']).optional(),
    opening_tax_value: z.coerce.number().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.tax_method && (value.tax_rule || value.opening_tax_value !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tax_method'],
        message: 'tax_method is required for a tax depreciation preview.',
      })
    }
    if (value.tax_method === 'rakenskapsenlig' && !value.tax_rule) {
      ctx.addIssue({
        code: 'custom',
        path: ['tax_rule'],
        message: 'tax_rule is required for räkenskapsenlig depreciation.',
      })
    }
    if (value.tax_method === 'restvarde' && value.tax_rule) {
      ctx.addIssue({
        code: 'custom',
        path: ['tax_rule'],
        message: 'tax_rule is not valid for restvärdeavskrivning.',
      })
    }
  })

export const GET = withRouteContext(
  'period.depreciation_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const query = validateQuery(request, TaxPreviewQuerySchema, {
      log,
      operation: 'period.depreciation_preview',
    })
    if (!query.success) return query.response
    try {
      const [ordinary, tax] = await Promise.all([
        proposeAnnualPostings(supabase, companyId, id),
        query.data.tax_method
          ? previewTaxDepreciationElection(supabase, companyId, id, {
              method: query.data.tax_method,
              selectedRule: query.data.tax_rule,
              openingTaxValue: query.data.opening_tax_value,
            })
          : loadTaxDepreciationView(supabase, companyId, id),
      ])
      return NextResponse.json({ data: { ...ordinary, tax } })
    } catch (err) {
      if (err instanceof TaxDepreciationValidationError) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          status: 400,
          messageSv: 'Valet för skattemässig avskrivning är ogiltigt.',
          messageEn: 'The tax depreciation election is invalid.',
        })
      }
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)

export const PUT = withRouteContext(
  'period.tax_depreciation_save',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, TaxElectionSchema)
    if (!validation.success) return validation.response

    try {
      const tax = await saveTaxDepreciationElection(
        supabase,
        companyId,
        user.id,
        id,
        {
          method: validation.data.method,
          selectedRule: validation.data.selected_rule,
          openingTaxValue: validation.data.opening_tax_value,
          electedDeduction: validation.data.elected_deduction,
          bookConformityConfirmed: validation.data.book_conformity_confirmed,
        },
      )
      return NextResponse.json({ data: tax })
    } catch (err) {
      if (err instanceof TaxDepreciationValidationError) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          status: 400,
          messageSv: 'Valet för skattemässig avskrivning är ogiltigt.',
          messageEn: 'The tax depreciation election is invalid.',
        })
      }
      if (err instanceof TaxDepreciationPeriodLockedError) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)

export const POST = withRouteContext(
  'period.depreciation_commit',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CommitSchema)
    if (!validation.success) return validation.response

    try {
      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }

      const result = await commitAnnualPostings(supabase, companyId, user.id, id, {
        assetIds: validation.data.asset_ids,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
