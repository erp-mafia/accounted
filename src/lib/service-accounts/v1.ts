/**
 * What the v1 service-account routes share: the request and response
 * schemas the registry publishes, the caller built from the route context,
 * and the one gate and failure mapping every route runs.
 *
 * Routes: /api/v1/companies/{companyId}/service-accounts (GET list, POST
 * create), /{id} (GET), /{id}/revoke (POST), /{id}/keys (POST mint) and
 * /{id}/keys/{keyId}/revoke (POST). All need the scope
 * service_accounts:manage, a person's key, and an owner or admin.
 */
import { z } from 'zod'
import type { NextResponse } from 'next/server'
import { ALL_SCOPES, type ApiKeyScope } from '@/lib/auth/api-keys'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import type { ApiV1Context } from '@/lib/api/v1/with-api-v1'
import {
  assertCanManageServiceAccounts,
  SERVICE_ACCOUNTS_MANAGE_SCOPE,
  type ServiceAccountCaller,
  type ServiceAccountFailure,
} from './service'

const UUID = z.string().uuid()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True for a well-formed id. A malformed path id is answered like an id that
 * is not the company's (404), without a query that would fail on the cast.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export const ServiceAccountSchema = z.object({
  id: UUID,
  company_id: UUID,
  name: z.string().describe('Shown as the actor of every write the account makes (behandlingshistorik, the voucher).'),
  sponsor_user_id: UUID.describe(
    'The person who answers for the account: an owner or admin of the company. Its keys act as this user for access, and every row they write carries this user.',
  ),
  status: z
    .enum(['active', 'suspended', 'revoked'])
    .describe(
      'active: its keys work. suspended: the sponsor is no longer an owner or admin (or the company is archived), so its keys answer 403 SERVICE_ACCOUNT_SUSPENDED until that changes. revoked: final, its keys are revoked.',
    ),
  created_by: UUID,
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  revoked_by: UUID.nullable(),
})

export const ServiceAccountKeySchema = z.object({
  id: UUID,
  name: z.string(),
  key_prefix: z.string().describe('The first characters of the key, for recognising it. The key itself is shown once, when minted.'),
  scopes: z.array(z.string()),
  mode: z.enum(['live', 'test']),
  access: z
    .enum(['read_write', 'read_only'])
    .describe('read_only: only read scopes apply in the company, whatever scopes the key holds.'),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
})

export const ServiceAccountDetailSchema = ServiceAccountSchema.extend({
  keys: z.array(ServiceAccountKeySchema).describe('Every key of the account, live and revoked, newest first. Never the secrets.'),
})

export const MintedServiceAccountKeySchema = ServiceAccountKeySchema.extend({
  service_account_id: UUID,
  key: z
    .string()
    .describe('The secret (gnubok_sk_...), returned exactly once: store it now. Only its SHA-256 is kept.'),
})

const NAME = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim().length > 0, { message: 'name must not be blank' })

export const CreateServiceAccountBody = z.object({
  name: NAME.describe('Unique among the company\'s live service accounts; leading and trailing spaces are dropped.'),
  sponsor_user_id: UUID.optional().describe(
    'The sponsor: an owner or admin member of the company. Defaults to the user of the calling key.',
  ),
})

const GRANTABLE_SCOPES = ALL_SCOPES.filter((scope) => scope !== SERVICE_ACCOUNTS_MANAGE_SCOPE) as [
  ApiKeyScope,
  ...ApiKeyScope[],
]

export const MintServiceAccountKeyBody = z.object({
  name: NAME.optional().describe('A label for this key. Defaults to the account\'s name.'),
  scopes: z
    .array(z.enum(GRANTABLE_SCOPES))
    .min(1)
    .max(GRANTABLE_SCOPES.length)
    .describe(
      'What the key may do. Each must be a scope the calling key holds itself; service_accounts:manage is never granted to a service account.',
    ),
  mode: z.enum(['live', 'test']).optional().describe('live (default) or test: a test key forces dry-run on every write.'),
  read_only: z
    .boolean()
    .optional()
    .describe('true: the key may only read in the company, whatever its scopes. Default false.'),
  acknowledge_sod: z
    .boolean()
    .optional()
    .describe(
      'Required true when scopes combine a staging write scope with pending_operations:approve (segregation of duties): otherwise 409 API_KEY_SOD_CONFLICT.',
    ),
})

/** The caller of a service-account door, from the v1 context. */
export function serviceAccountCaller(ctx: ApiV1Context): ServiceAccountCaller {
  return {
    userId: ctx.userId,
    scopes: ctx.scopes,
    serviceAccount: ctx.serviceAccount,
    actor: ctx.actor,
  }
}

/** A domain refusal as the v1 error envelope. */
export function serviceAccountFailureResponse(
  ctx: Pick<ApiV1Context, 'requestId' | 'log'>,
  failure: ServiceAccountFailure,
): Promise<NextResponse> {
  return v1ErrorResponseFromCode(failure.code, ctx.log, {
    requestId: ctx.requestId,
    ...(failure.details ? { details: failure.details } : {}),
  })
}

/**
 * The gate every service-account route runs first: a person's key held by an
 * owner or admin of the URL company. Null when the caller may proceed, else
 * the error response to return as-is.
 */
export async function serviceAccountGate(ctx: ApiV1Context): Promise<NextResponse | null> {
  const refusal = await assertCanManageServiceAccounts(ctx.supabase, ctx.companyId!, serviceAccountCaller(ctx))
  if (!refusal) return null
  ctx.log.warn('service-account door refused the caller', { code: refusal.code })
  return serviceAccountFailureResponse(ctx, refusal)
}

/** Error codes every service-account route can answer, beside the wrapper's own. */
export const SERVICE_ACCOUNT_GATE_ERROR_CODES = [
  'UNAUTHORIZED',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'RATE_LIMITED',
  'SERVICE_ACCOUNT_KEY_NOT_PERMITTED',
  'SERVICE_ACCOUNT_ADMIN_REQUIRED',
  'SERVICE_ACCOUNT_SUSPENDED',
  'INTERNAL_ERROR',
]

/** Example rows for the registry. */
export const EXAMPLE_SERVICE_ACCOUNT = {
  id: '5b6c1d2e-0000-4000-8000-0000000000a1',
  company_id: '8fd5b1f4-0000-4000-8000-000000000001',
  name: 'Nattlig fakturasynk',
  sponsor_user_id: '3f2a9c10-0000-4000-8000-000000000002',
  status: 'active' as const,
  created_by: '3f2a9c10-0000-4000-8000-000000000002',
  created_at: '2026-10-16T08:00:00Z',
  revoked_at: null,
  revoked_by: null,
}

export const EXAMPLE_SERVICE_ACCOUNT_KEY = {
  id: '7a1e0c55-0000-4000-8000-0000000000b1',
  name: 'Nattlig fakturasynk',
  key_prefix: 'gnubok_sk_Xb3kQ9aZ',
  scopes: ['invoices:read', 'invoices:write'],
  mode: 'live' as const,
  access: 'read_write' as const,
  created_at: '2026-10-16T08:01:00Z',
  last_used_at: null,
  revoked_at: null,
}
