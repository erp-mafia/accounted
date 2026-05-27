import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  getNarrative,
  upsertNarrative,
} from '@/lib/bokslut/arsredovisning/narrative-service'

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
  // control bytes (NUL, ESC, etc.) at the schema layer — otherwise a
  // tampered payload could corrupt PDF output or hide content from auditors.
  description: sanitizedText(4000).nullable().optional(),
  important_events: sanitizedText(4000).nullable().optional(),
  resultatdisposition: sanitizedText(2000).nullable().optional(),
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
  // Cap at 1 trillion SEK — well above any realistic Swedish company's
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
  // Swedish organisationsnummer NNNNNN-NNNN. Third digit ≥ 2 distinguishes
  // legal-entity org numbers from personnummer (whose third digit forms part
  // of a month, 0-1). ÅRL 5:13–15 disclosure is about parent legal entities,
  // so personnummer-shaped values are out of scope and a GDPR Art.5(1)(c)
  // data-minimisation concern if persisted. Empty string clears the override.
  parent_company_org_number: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{2}[2-9]\d{3}-\d{4}$/, {
        message: 'Ogiltigt organisationsnummer (NNNNNN-NNNN, ej personnummer)',
      }),
    ])
    .nullable()
    .optional(),
  parent_company_city: sanitizedText(100).nullable().optional(),
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
      // writing — defense-in-depth alongside RLS, gives a cleaner 404 than
      // the RLS rejection envelope. Also refuse mutations on locked/closed
      // periods (BFL 5 kap 5 § — räkenskapsinformation immutability).
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.locked_at || period.closing_entry_id) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }
      const data = await upsertNarrative(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
