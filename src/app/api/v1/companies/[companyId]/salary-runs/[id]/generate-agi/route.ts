/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/generate-agi
 *
 * Generates the Skatteverket AGI (arbetsgivardeklaration på individnivå) XML
 * for a salary run and persists the declaration. Calls the shared
 * `generateAgiDeclaration()` helper that the dashboard's GET /agi/xml also
 * uses, so the XML is byte-equivalent across surfaces.
 *
 * SYNC, not async. Despite the original plan annotating this as "(async)",
 * the actual work is sub-second: in-memory XML generation, one UPSERT into
 * agi_declarations, one UPDATE on salary_runs.agi_generated_at, one
 * optimistic-lock UPDATE on deadlines, one event emit. Using the
 * `operations` substrate here would be over-engineering: the response
 * comes back fast enough that polling would just be friction. Documented
 * as a deliberate plan deviation.
 *
 * Response shape: v1 JSON envelope with the XML embedded as a string field
 * (`xml`). Agents extract `data.xml` and save / forward as needed. This
 * preserves the v1 envelope's request_id + audit headers; an agent who
 * wants a download-flavored response can wrap the call themselves.
 *
 * Status gate: review|approved|paid|booked|corrected. Mirrors the
 * dashboard exactly. The Swedish-compliance review in PR-1 suggested
 * tightening to `approved+` because AGI from `review` could submit
 * incorrect figures to Skatteverket. That's a real concern but a design
 * decision orthogonal to this PR: narrowing the gate would diverge from
 * the dashboard's behavior. Tracked for a future tightening.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { generateAgiDeclaration } from '@/lib/salary/agi/generate-declaration'

const AvgifterCategory = z.object({ basis: z.number(), amount: z.number() })

const AgiTotals = z.object({
  totalTax: z.number(),
  totalAvgifterBasis: z.number(),
  totalAvgifterAmount: z.number(),
  totalSjuklonekostnad: z.number(),
  avgifterByCategory: z.record(z.string(), AvgifterCategory),
})

const AgiGenerated = z.object({
  agi_declaration_id: z.string().uuid(),
  period_year: z.number().int(),
  period_month: z.number().int(),
  employee_count: z.number().int(),
  is_correction: z.boolean(),
  totals: AgiTotals,
  xml: z.string(),
  xml_filename: z.string(),
})

registerEndpoint({
  operation: 'salary-runs.generate-agi',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/generate-agi',
  summary: 'Generate the Skatteverket AGI XML for a salary run.',
  description:
    'Generates the arbetsgivardeklaration-på-individnivå XML for the run (HU section + per-employee IU + Frånvarouppgift for VAB/parental), upserts the agi_declarations row (correction-aware), stamps salary_runs.agi_generated_at, emits `agi.generated`, and auto-completes the `arbetsgivardeklaration` deadline. Returns the XML as a string field in the v1 envelope: agents extract `data.xml` and forward to Skatteverket directly (Mina Sidor upload or via a connected extension).',
  useWhen:
    'You\'ve reviewed (or approved / paid / booked) a salary run and need to file AGI with Skatteverket. The Skatteverket filing deadline is the 12th of the following month (17th in Jan / Aug for companies ≤40 MSEK turnover).',
  doNotUseFor:
    'Submitting the AGI to Skatteverket: this endpoint only generates and persists the XML. Submission is a separate flow via the (optional) `skatteverket` extension.',
  pitfalls: [
    'Run status must be one of review, approved, paid, booked, corrected: `draft` returns 400 AGI_GENERATE_NOT_BOOKABLE.',
    'Generating AGI from a `review`-status run risks submitting figures that will change at `:approve`. The dashboard allows this for flexibility; agents should prefer `approved+` unless an early-warning workflow specifically wants the preview.',
    'Subsequent calls for the same period UPDATE the agi_declarations row (is_correction=true) and overwrite the XML. The FK570 specifikationsnummer stays consistent per employee: different number = new record per Skatteverket spec.',
    'AGI_INCOMPLETE_DATA returns 400 when company contact info is missing (org_number, contact name, phone, email). Fix via /settings/company before retrying.',
    'The XML content is räkenskapsinformation: BFL 7 kap retention applies. The agi_declarations row is never auto-deleted.',
  ],
  example: {
    response: {
      data: {
        agi_declaration_id: 'agi_a8f1…',
        period_year: 2026,
        period_month: 5,
        employee_count: 3,
        is_correction: false,
        totals: {
          totalTax: 28500,
          totalAvgifterBasis: 105000,
          totalAvgifterAmount: 32991,
          totalSjuklonekostnad: 0,
          avgifterByCategory: { standard: { basis: 105000, amount: 32991 } },
        },
        xml: '<?xml version="1.0" encoding="UTF-8"?><Skatteverket omrade="Arbetsgivardeklaration">…</Skatteverket>',
        xml_filename: 'AGI_5566778899_202605.xml',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(AgiGenerated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.generate-agi',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }
    const salaryRunId = idParse.data

    // The helper is essentially idempotent: calling twice produces the
    // same XML with the second call marked is_correction=true. We do NOT
    // expose a dry-run here because the only state the helper changes is
    // (a) the agi_declarations row (cheap, idempotent), (b) the
    // salary_runs.agi_generated_at timestamp (cheap, idempotent), and
    // (c) the deadlines auto-complete (idempotent if already completed).
    // Adding dry-run plumbing would more than double the code for no
    // agent-facing benefit.

    // Pull the user's email so we can fall back to it when neither
    // company_settings.email nor profiles.email is present. The wrapper
    // doesn't carry the email: fetch via supabase auth admin.
    const { data: userRecord } = await ctx.supabase.auth.admin.getUserById(ctx.userId)
    const userEmail = userRecord?.user?.email ?? null

    const result = await generateAgiDeclaration({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      userId: ctx.userId,
      userEmail,
      salaryRunId,
      log: ctx.log,
      requestId: ctx.requestId,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
        status: result.status,
      })
    }

    // OWASP V3.2 / V4 (HTTP response header injection prevention) +
    // path-traversal hardening: sanitise the filename. The orgNumber
    // comes from company_settings (user-editable) so it can in theory
    // carry stray characters. The period digits are server-generated
    // but we strip anything non-numeric defensively. The resulting
    // filename is safe to put in a future Content-Disposition header by
    // any caller forwarding the response, and prevents path-traversal
    // characters from reaching agent file-write code that uses
    // xml_filename verbatim.
    const safeOrg = result.orgNumber.replace(/[^0-9A-Za-z-]/g, '')
    const safePeriod = `${result.periodYear}${String(result.periodMonth).padStart(2, '0')}`.replace(
      /[^0-9]/g,
      '',
    )
    const xmlFilename = `AGI_${safeOrg}_${safePeriod}.xml`

    return ok(
      {
        agi_declaration_id: result.agiDeclarationId,
        period_year: result.periodYear,
        period_month: result.periodMonth,
        employee_count: result.employeeCount,
        is_correction: result.isCorrection,
        totals: result.totals,
        xml: result.xml,
        xml_filename: xmlFilename,
      },
      { requestId: ctx.requestId },
    )
  },
)
