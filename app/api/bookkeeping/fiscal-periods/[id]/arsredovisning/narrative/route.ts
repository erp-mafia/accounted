import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  getNarrative,
  upsertNarrative,
} from '@/lib/bokslut/arsredovisning/narrative-service'
import {
  isValidParentCompanyIdentifier,
  PARENT_COMPANY_IDENTIFIER_ERROR,
} from '@/lib/bokslut/arsredovisning/parent-company-identifier'

// Strip non-printable control characters that would corrupt PDF output or
// mislead a human reader of the årsredovisning. Whitelist printable ASCII
// + every byte ≥ 0x20 (covers Latin-1 + UTF-8 multi-byte sequences) while
// allowing tab/LF/CR for legitimate line breaks.
const stripControlChars = (s: string): string =>
  s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

const sanitizedText = (max: number) =>
  z
    .string()
    .max(max)
    .transform(stripControlChars)

const PostSchema = z.object({
  // Match the DB CHECK lengths exactly so a payload that would fail at the
  // storage layer instead returns a clean 400 here. Free-text fields are
  // rendered verbatim into the årsredovisning PDF, so we strip ASCII
  // control bytes (NUL, ESC, etc.) at the schema layer: otherwise a
  // tampered payload could corrupt PDF output or hide content from auditors.
  description: sanitizedText(4000).nullable().optional(),
  important_events: sanitizedText(4000).nullable().optional(),
  resultatdisposition: sanitizedText(2000).nullable().optional(),
  proposed_dividend: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .transform((value) =>
      value === null || value === undefined ? value : Math.round(value * 100) / 100,
    ),
  // ISO YYYY-MM-DD per the DATE column; null clears it. Validate as a
  // real calendar date (not just regex) so '2024-13-99' returns 400 from
  // the API instead of bubbling up as a Postgres 500.
  agm_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (s) => {
        const d = new Date(`${s}T00:00:00Z`)
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
      },
      { message: 'Invalid calendar date' },
    )
    .nullable()
    .optional(),
  // Disclosure fields per ÅRL 5:13-15 § + BFNAR koncernförhållanden. All
  // optional; null clears the override and the builder falls back to
  // boilerplate ("Inga." / "Inga skulder förfaller efter mer än fem år.").
  // Cap at 1 trillion SEK, well above any realistic Swedish company's
  // long-term debt (Volvo Group ~500 G SEK), prevents overflow in PDF
  // formatting and downstream numeric handling.
  long_term_debt_over_five_years: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional(),
  securities_pledged: sanitizedText(4000).nullable().optional(),
  contingent_liabilities: sanitizedText(4000).nullable().optional(),
  parent_company_name: sanitizedText(200).nullable().optional(),
  // Swedish organisationsnummer or a foreign parent's registration identifier
  // (a Swiss holding's CHE-number was refused as "ej personnummer" on
  // 2026-08-20). Rules live in parent-company-identifier.ts; personnummer-
  // shaped values stay rejected. Empty string clears the override.
  parent_company_org_number: z
    .union([
      z.literal(''),
      z.string().max(40).refine(isValidParentCompanyIdentifier, {
        message: PARENT_COMPANY_IDENTIFIER_ERROR,
      }),
    ])
    .nullable()
    .optional(),
  parent_company_city: sanitizedText(100).nullable().optional(),
  long_term_debt_over_five_years_confirmed: z.boolean().optional(),
  securities_pledged_confirmed: z.boolean().optional(),
  contingent_liabilities_confirmed: z.boolean().optional(),
  parent_company_confirmed: z.boolean().optional(),
  agm_disposition_outcome: z
    .enum(['proposal_approved', 'alternative_decision'])
    .nullable()
    .optional(),
  agm_disposition_decision: sanitizedText(2000).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.agm_disposition_outcome === 'alternative_decision' &&
    !value.agm_disposition_decision?.trim()
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['agm_disposition_decision'],
      message: 'Årsstämmans alternativa beslut måste beskrivas.',
    })
  }
})

export const GET = withRouteContext(
  'period.arsredovisning_narrative_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Mirror the POST handler's period-ownership pre-check so a valid
      // JWT for company A can't probe / enumerate company B's period IDs
      // through this endpoint.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const data = await getNarrative(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const POST = withRouteContext(
  'period.arsredovisning_narrative_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PostSchema)
    if (!validation.success) return validation.response
    try {
      // Verify the fiscal period belongs to the authenticated company before
      // writing: defense-in-depth alongside RLS, gives a cleaner 404 than
      // the RLS rejection envelope.
      //
      // Deliberately NOT gated on the bookkeeping period lock: the narrative
      // is årsredovisning document text (ÅRL 6 kap.), not räkenskapsinformation
      // in the journal, and the normal flow closes the period BEFORE the
      // årsredovisning is written. The document freezes when it is filed:
      // a Bolagsverket submission registered for this period makes the text
      // read-only (what was uploaded is already immutable via the
      // arsredovisning_submissions trigger + stored document).
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      // Only 'registrerad' freezes the text. 'avslutad' (case closed WITHOUT
      // registration, e.g. withdrawn or rejected) deliberately stays
      // editable: the document was never registered at Bolagsverket and a
      // refiling needs amendable narrative text.
      const { data: registered, error: registeredError } = await supabase
        .from('arsredovisning_submissions')
        .select('id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .eq('status', 'registrerad')
        .limit(1)
        .maybeSingle()
      if (registeredError) {
        throw new Error(`Failed to check submission status: ${registeredError.message}`)
      }
      if (registered) {
        return errorResponseFromCode('ARSREDOVISNING_REGISTERED', log, { requestId })
      }
      const data = await upsertNarrative(supabase, companyId, user.id, id, validation.data)
      const { error: confirmationError } = await supabase
        .from('annual_report_profiles')
        .update({ narrative_confirmed_at: null })
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
      if (confirmationError) {
        throw new Error(`Failed to clear narrative confirmation: ${confirmationError.message}`)
      }
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
