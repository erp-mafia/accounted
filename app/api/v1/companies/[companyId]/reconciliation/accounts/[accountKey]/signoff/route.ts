/**
 * GET  /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff
 *
 * Sign-off history, and the sign-off itself ("markera som avstämd t.o.m.
 * <datum>"). A sign-off is the attestation on top of the engine's bridge:
 * refused unless the account is reconciled through the date, or the caller
 * forces it with a note. Writes nothing to the ledger. Dry-runnable;
 * Idempotency-Key required on POST.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { AccountKeySchema, ReconciliationSignoffSchema } from '@/lib/reconciliation/schemas'
import { listSignoffs } from '@/lib/reconciliation/signoff-store'
import { ReconciliationSignoffError, signOffAccount } from '@/lib/reconciliation/signoff'
import { ISO_DATE_RE } from '@/lib/invariants'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const SignoffRequest = z.object({
  through_date: z.string().regex(ISO_DATE_RE),
  note: z.string().max(2000).nullable().optional(),
  force: z.boolean().optional(),
  external_balance: z.number().finite().nullable().optional(),
})

const SignoffResponse = z.object({
  dry_run: z.boolean(),
  signoff: ReconciliationSignoffSchema.optional(),
  would_sign: z
    .object({
      account_key: z.string(),
      through_date: z.string(),
      external_balance: z.number().nullable(),
      ledger_balance: z.number().nullable(),
      unexplained_difference: z.number().nullable(),
      is_reconciled: z.boolean(),
      forced: z.boolean(),
      previous_through_date: z.string().nullable(),
    })
    .optional(),
})

const SignoffListResponse = z.object({ signoffs: z.array(ReconciliationSignoffSchema) })

const EXAMPLE_SIGNOFF = {
  id: '77777777-7777-4777-8777-777777777777',
  account_key: 'skattekonto',
  through_date: '2026-07-31',
  external_balance: 12450.0,
  ledger_balance: 12450.0,
  unexplained_difference: 0,
  note: null,
  signed_by: '88888888-8888-4888-8888-888888888888',
  signed_at: '2026-08-03T09:12:00Z',
  reopened_at: null,
  reopened_by: null,
  reopen_reason: null,
}

registerEndpoint({
  operation: 'reconciliation.accounts.signoff.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/signoff',
  summary: 'Sign-off history for one reconcilable account.',
  description:
    'Every "avstämt t.o.m." sign-off on the account, newest first. Active ones by default; ?include_reopened=true adds the reopened (undone) ones with their reopen stamp. The latest active sign-off also rides along on GET .../accounts/{accountKey} as `signoff`.',
  useWhen: 'You need the attestation trail (who signed what through which date) for an account, e.g. for a close checklist or an audit question.',
  doNotUseFor: 'Deciding whether the account is reconciled today: read unexplained_difference on the account status for that.',
  pitfalls: [
    'A sign-off is an assertion made at a point in time; rows or links added later can make the live bridge differ from the signed numbers. Compare signoff.unexplained_difference with the current status when that matters.',
  ],
  example: {
    response: { data: { signoffs: [EXAMPLE_SIGNOFF] }, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'reconciliation:read',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  response: { success: dataEnvelope(SignoffListResponse) },
})

registerEndpoint({
  operation: 'reconciliation.accounts.signoff.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/signoff',
  summary: 'Mark an account reconciled through a date (sign-off).',
  description:
    'Body: { through_date: "YYYY-MM-DD", note?, force?, external_balance? }. Recomputes the bridge through the date and refuses unless unexplained_difference is zero; with force: true and a note it signs anyway and records the difference. Refuses dates in the future, dates past the skattekonto snapshot (NOT_FETCHED_THROUGH), and dates at or before an existing active sign-off (ALREADY_SIGNED_OFF: reopen that one first). For a manual:NNNN account without a system specification (anything but 1510/2440/2920/2940), external_balance is the balance per the signer\'s underlag in ledger sign (liabilities negative); the difference against the booked balance is recorded, and a non-zero one still needs force + note. On bank, skattekonto and specification accounts external_balance is refused (EXTERNAL_BALANCE_NOT_ALLOWED). ?dry_run=true returns would_sign without writing. Undo with POST .../signoff/{signoffId}/reopen.',
  useWhen: 'The month (or period) is explained and you want the account marked as reconciled through its last day, as a human would in the Avstämning page.',
  doNotUseFor: 'Linking rows or booking anything: a sign-off changes no data in the ledger. Use .../links and the booking endpoints first.',
  pitfalls: [
    'Refusal codes come back as VALIDATION_ERROR with details.code: INVALID_DATE, DATE_IN_FUTURE, NOT_FETCHED_THROUGH, OUTSIDE_UNKNOWN, NOT_RECONCILED, NOTE_REQUIRED, EXTERNAL_BALANCE_NOT_ALLOWED; ALREADY_SIGNED_OFF and SIGNOFF_RACE come back as CONFLICT.',
    'force: true without a note is NOTE_REQUIRED: the note is what the next reader sees next to the non-zero difference.',
    'Idempotency-Key is required; repeating the same key replays the first response.',
  ],
  example: {
    request: { through_date: '2026-07-31' },
    response: {
      data: { dry_run: false, signoff: EXAMPLE_SIGNOFF },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:signoff',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  request: { body: SignoffRequest },
  response: { success: dataEnvelope(SignoffResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.signoff.list',
  async (request, ctx, params) => {
    const { accountKey } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'accountKey', message: 'Okänt konto.' },
      })
    }
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, 200)
    const includeReopened = searchParams.get('include_reopened') === 'true' || searchParams.get('include_reopened') === '1'
    try {
      const signoffs = await listSignoffs(ctx.supabase, ctx.companyId!, accountKey, { limit, includeReopened })
      return ok({ signoffs }, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)

export const POST = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.signoff.create',
  async (request, ctx, params) => {
    const { accountKey } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'accountKey', message: 'Okänt konto.' },
      })
    }
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = SignoffRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    try {
      const result = await signOffAccount(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        accountKey,
        {
          through_date: parsed.data.through_date,
          note: parsed.data.note ?? null,
          force: parsed.data.force,
          external_balance: parsed.data.external_balance ?? null,
        },
        { dryRun: ctx.dryRun },
      )
      if (!result) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      if (ctx.dryRun) {
        return dryRunPreview(result, { requestId: ctx.requestId, log: ctx.log })
      }
      return ok(result, { requestId: ctx.requestId })
    } catch (err) {
      if (err instanceof ReconciliationSignoffError) {
        const v1Code =
          err.code === 'SIGNOFF_NOT_FOUND'
            ? 'NOT_FOUND'
            : err.code === 'ALREADY_SIGNED_OFF' || err.code === 'SIGNOFF_RACE'
              ? 'CONFLICT'
              : 'VALIDATION_ERROR'
        return v1ErrorResponseFromCode(v1Code, ctx.log, {
          requestId: ctx.requestId,
          details: { code: err.code, message: getErrorMessage(err) },
        })
      }
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
