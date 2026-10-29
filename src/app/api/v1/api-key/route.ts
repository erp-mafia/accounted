/**
 * GET /api/v1/api-key: the calling key's own grant.
 *
 * An integrator used to learn what a key may do only by trying: the first
 * upload answered 403 INSUFFICIENT_SCOPE, ROLE_READ_ONLY or
 * CONNECTION_READ_ONLY, or TEST_KEY_WRITE_BLOCKED, long after the customer
 * had left the connect screen. This route answers the same questions up
 * front, from the same sources the wrapper enforces: the key's mode and
 * scopes, whether it reaches every membership or an allowlist, and per
 * reachable company the role and whether the company gate lets a write
 * through (`companyWriteRefusal`, shared with the gate itself).
 *
 * Any valid key may call it, whatever its scopes (its endpoint declares scope 'authenticated'):
 * a key missing a scope must still be able to learn which one it misses.
 * It returns company ids and roles only, never names or org numbers, which
 * stay behind companies:read on GET /api/v1/companies. The one name it
 * returns is the key's own service account's (id, name, handle; null for a
 * person's key): the actor its writes are recorded under. Echoing a grant to
 * its own holder is fine; logging it is not, so nothing here logs the
 * scopes.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { companyWriteRefusal, withApiV1 } from '@/lib/api/v1/with-api-v1'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { handlePattern, toHandle } from '@/lib/handles'
import type { ApiKeyServiceAccount } from '@/lib/auth/api-keys'

const ROLES = ['owner', 'admin', 'member', 'viewer', 'invoicer'] as const

const KeyCompany = z.object({
  id: z.string().uuid(),
  role: z.enum(ROLES),
  access: z.enum(['read_write', 'read_only']),
  read_only_code: z.enum(['ROLE_READ_ONLY', 'CONNECTION_READ_ONLY']).nullable(),
})

const KeyServiceAccount = z.object({
  id: z.string().uuid(),
  name: z.string().describe('The account\'s name: the actor every write made with this key is recorded under.'),
  handle: z
    .string()
    .regex(new RegExp(handlePattern('service_account')))
    .describe('Typed handle of this service account: svc_ plus its id as 32 lowercase hex. Accepted wherever the id is.'),
})

const ApiKeyGrant = z.object({
  mode: z.enum(['live', 'test']),
  scopes: z.array(z.string()),
  company_access: z.enum(['all_memberships', 'allowlist']),
  companies: z.array(KeyCompany),
  service_account: KeyServiceAccount.nullable().describe(
    'The service account the key belongs to, or null for a key that belongs to a person. A service account\'s key acts for its sponsor and reaches only the account\'s company.',
  ),
})

/** The calling key's service account as the response names it, or null for a person's key. */
function serviceAccountView(account: ApiKeyServiceAccount | null | undefined) {
  if (!account) return null
  // The id comes from service_accounts.id, a uuid column, so it always has a handle.
  return { id: account.id, name: account.name, handle: toHandle('service_account', account.id)! }
}

registerEndpoint({
  operation: 'api-key.get',
  method: 'GET',
  path: '/api/v1/api-key',
  summary: 'Show what the calling API key may do: mode, scopes and company access.',
  description:
    'Returns the grant of the key that makes the request: `mode` (`live` or `test`), its `scopes`, whether it reaches ' +
    'every company its user is a member of (`all_memberships`) or only an allowlist (`allowlist`), and every company it ' +
    'reaches with the role and whether writes are let through there. `access` is `read_only` when the membership is ' +
    'a viewer (`read_only_code` `ROLE_READ_ONLY`) or the key was given read-only access to the company ' +
    '(`CONNECTION_READ_ONLY`): the same codes a refused write answers with. Any valid key may call this, whatever its ' +
    'scopes, and it works the same for keys issued through MCP OAuth. A key can write to company X with scope S when ' +
    '`scopes` contains S, X is in `companies` with `access` `read_write`, and `mode` is `live` or the endpoint supports ' +
    'dry-run. For document uploads: `documents:write`, `read_write`, and `mode` `live`. `service_account` names the ' +
    'service account the key belongs to (`id`, `name`, `handle`), or is null for a key that belongs to a person.',
  useWhen:
    'You connect a customer key and want to check, before the first real call, that it carries the scopes you need and can write to the company you will use, so the customer can fix the key while still on your connect screen.',
  doNotUseFor:
    'Company names, org numbers or settings: use GET /api/v1/companies (scope companies:read). Testing a single write end to end: send it with `?dry_run=true` where the endpoint supports dry-run.',
  pitfalls: [
    'A test key (`mode` `test`) forces every write into dry-run, and an endpoint without dry-run support refuses it with 403 TEST_KEY_WRITE_BLOCKED. POST /companies/{companyId}/documents is one: uploads need a live key.',
    'The grant can change after you read it: the customer can edit the key\'s scopes or company access, or remove the user from a company. Keep handling 403 INSUFFICIENT_SCOPE, ROLE_READ_ONLY and CONNECTION_READ_ONLY on real calls.',
    'With `company_access` `all_memberships`, companies the user joins later become reachable too; an `allowlist` key never reaches a company outside its list, including one it creates with POST /companies.',
    'A non-owner membership in a company whose multi-user plan has lapsed is refused on every call (403 with reason `multi_user_frozen`); this response does not show that state.',
    'Archived companies are not listed, the same as GET /api/v1/companies.',
    'A service account\'s key reaches only the account\'s company, and every write it makes is recorded under the account\'s name. When the sponsor stops being an owner or admin, the key is refused with 403 SERVICE_ACCOUNT_SUSPENDED, here too.',
    'While the person responsible for the agent has paused it, every key of the agent is refused with 403 AGENT_PAUSED, here too. Tell the user; only that person can resume it, under Settings.',
  ],
  example: {
    response: {
      data: {
        mode: 'live',
        scopes: ['companies:read', 'documents:read', 'documents:write'],
        company_access: 'allowlist',
        companies: [
          {
            id: '8fd5b1f4-0000-4000-8000-000000000001',
            role: 'owner',
            access: 'read_write',
            read_only_code: null,
          },
          {
            id: '8fd5b1f4-0000-4000-8000-000000000002',
            role: 'admin',
            access: 'read_only',
            read_only_code: 'CONNECTION_READ_ONLY',
          },
        ],
        service_account: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'authenticated',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(ApiKeyGrant),
    errorCodes: ['UNAUTHORIZED', 'SERVICE_ACCOUNT_SUSPENDED', 'AGENT_PAUSED', 'RATE_LIMITED', 'INTERNAL_ERROR'],
  },
})

type MembershipRow = { company_id: string; role: (typeof ROLES)[number] }

export const GET = withApiV1('api-key.get', async (_request, ctx) => {
  // The companies the key reaches: live non-archived memberships, narrowed by
  // the allowlist when the key has one (the same set GET /companies lists).
  // Ordered on company_id, unique per user, so fetchAllRows pages stably.
  const memberships = await fetchAllRows<MembershipRow>(({ from, to }) => {
    let query = ctx.supabase
      .from('company_members')
      .select('company_id, role, companies:company_id!inner(archived_at)')
      .eq('user_id', ctx.userId)
      .is('companies.archived_at', null)
    if (ctx.allowedCompanyIds) query = query.in('company_id', ctx.allowedCompanyIds)
    return query.order('company_id', { ascending: true }).range(from, to)
  })

  const companies = memberships.map((row) => {
    const refusal = companyWriteRefusal(row.role, row.company_id, ctx.readOnlyCompanyIds)
    return {
      id: row.company_id,
      role: row.role,
      access: refusal ? ('read_only' as const) : ('read_write' as const),
      read_only_code: refusal,
    }
  })

  return ok(
    {
      mode: ctx.mode,
      scopes: ctx.scopes,
      company_access: ctx.allowedCompanyIds ? ('allowlist' as const) : ('all_memberships' as const),
      companies,
      service_account: serviceAccountView(ctx.serviceAccount),
    },
    { requestId: ctx.requestId },
  )
})
