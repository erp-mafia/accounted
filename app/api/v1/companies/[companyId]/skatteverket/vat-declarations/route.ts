/**
 * GET /api/v1/companies/{companyId}/skatteverket/vat-declarations
 *
 * Read a period's momsdeklaration as Skatteverket has it on file: the
 * submitted declaration (inlamnat) and/or Skatteverket's beslut (beslutat).
 * Issue #1663: lets integrators compare their books against actually-filed
 * data (e.g. year-over-year sanity checks), which Skatteverket's own portal
 * blocks from automation.
 *
 * Core cannot import from `@/extensions/` (CI guard), so the Skatteverket
 * call goes through the registry-resolved `services` channel declared in
 * lib/skatteverket/declaration-status.ts: same pattern the pending-operations
 * dispatcher uses for the SKV commit services.
 */
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { SkatteverketReadServices } from '@/lib/skatteverket/declaration-status'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'

ensureInitialized()

const Query = z
  .object({
    period_type: z.enum(['monthly', 'quarterly', 'yearly']),
    year: z.coerce.number().int().min(2000).max(2100),
    period: z.coerce.number().int().min(1).max(12),
    state: z.enum(['submitted', 'decided', 'both']).optional(),
  })
  .superRefine((val, issueCtx) => {
    const max = val.period_type === 'monthly' ? 12 : val.period_type === 'quarterly' ? 4 : 1
    if (val.period > max) {
      issueCtx.addIssue({
        code: 'custom',
        path: ['period'],
        message: `period must be 1-${max} for period_type=${val.period_type}`,
      })
    }
  })

const VatDeclarationStatus = z.object({
  redovisare: z.string(),
  redovisningsperiod: z.string(),
  submitted: z.unknown().nullable(),
  decided: z.unknown().nullable(),
})

const VatDeclarationStatusResponse = dataEnvelope(VatDeclarationStatus)

registerEndpoint({
  operation: 'skatteverket.vat_declarations.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/skatteverket/vat-declarations',
  summary: 'Read a filed momsdeklaration (submitted and/or decided) from Skatteverket.',
  description:
    'Fetches the momsdeklaration for one period as Skatteverket has it on file: `submitted` is the declaration as filed (SKV /inlamnat), `decided` is Skatteverket\'s beslut (SKV /beslutat). Either section is null when nothing is on file for the period (or when excluded via ?state=). Query params: period_type (monthly|quarterly|yearly), year, period (1-12 monthly, 1-4 quarterly, 1 yearly), optional state (submitted|decided|both, default both). Requires the company to have an active Skatteverket connection (any member\'s BankID connection, or a verified ombud grant). Live read against Skatteverket, not a cached copy.',
  useWhen:
    'You want to verify what was actually filed for a VAT period, compare a period against last year\'s filed declaration, or check whether Skatteverket has decided a period.',
  doNotUseFor:
    'Computing the declaration from the books (use the VAT report), or filing: submission is a separate BankID-signed flow.',
  pitfalls: [
    'This is a live Skatteverket read: it fails with SKATTEVERKET_NOT_CONNECTED (401) when the company has neither a member\'s BankID connection (made under Installningar) nor a verified ombud grant, and the response reflects SKV\'s state, not the books. Personal BankID sessions expire after ~1 hour by design, so an expired connection is normal: ask the user to reconnect; only a person can, so do not retry until they confirm.',
    'submitted=null and decided=null with HTTP 200 means "nothing on file for the period": it is not an error.',
    'A submitted declaration can lack a beslut for days: poll decided separately rather than assuming both appear together.',
    'redovisningsperiod is SKV\'s YYYYMM format (the period\'s LAST month): quarterly period 1 is 03, not 01.',
  ],
  example: {
    request: { period_type: 'quarterly', year: 2026, period: 1 },
    response: {
      data: {
        redovisare: '165560000167',
        redovisningsperiod: '202603',
        submitted: { mervardesskattTillfalle: '2026-04-10' },
        decided: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'compliance:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: Query },
  response: {
    success: VatDeclarationStatusResponse,
    errorCodes: [
      'EXTENSION_DISABLED',
      'SKATTEVERKET_NOT_CONNECTED',
      'SKATTEVERKET_ACCESS_DENIED',
      'SKATTEVERKET_RATE_LIMITED',
      'SKATTEVERKET_API_ERROR',
      'VALIDATION_ERROR',
    ],
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'skatteverket.vat_declarations.get',
  async (request, ctx) => {
    const url = new URL(request.url)
    const parsed = Query.safeParse({
      period_type: url.searchParams.get('period_type') ?? undefined,
      year: url.searchParams.get('year') ?? undefined,
      period: url.searchParams.get('period') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    // The skatteverket extension is opt-in (extensions.config.json) and the
    // registry is the runtime source of truth: absent registration means the
    // deployment does not offer the integration at all.
    const services = extensionRegistry.get('skatteverket')?.services as
      | Partial<SkatteverketReadServices>
      | undefined
    if (!services?.fetchVatDeclarationStatus) {
      return v1ErrorResponseFromCode('EXTENSION_DISABLED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const result = await services.fetchVatDeclarationStatus(
      ctx.supabase,
      ctx.userId,
      ctx.companyId!,
      {
        periodType: parsed.data.period_type,
        year: parsed.data.year,
        period: parsed.data.period,
        state: parsed.data.state,
      },
    )

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        status: result.http_status,
        details: { message: result.error },
      })
    }

    return ok(
      {
        redovisare: result.redovisare,
        redovisningsperiod: result.redovisningsperiod,
        submitted: result.submitted ?? null,
        decided: result.decided ?? null,
      },
      { requestId: ctx.requestId },
    )
  },
)
