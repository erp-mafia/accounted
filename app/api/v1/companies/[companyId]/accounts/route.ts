/**
 * GET /api/v1/companies/{companyId}/accounts
 *
 * List chart-of-accounts entries (BAS chart). Filter by ?class=1..8
 * (BAS account class) and ?active=false (include archived). Sorted by
 * sort_order — agents can render the BAS hierarchy directly from this.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const Account = z.object({
  account_number: z.string(),
  account_name: z.string(),
  account_class: z.number().int().min(1).max(8),
  account_group: z.string(),
  account_type: z.string(),
  normal_balance: z.string(),
  is_system_account: z.boolean(),
  is_active: z.boolean(),
  description: z.string().nullable(),
  default_vat_code: z.string().nullable(),
  sru_code: z.string().nullable(),
  sort_order: z.number().int(),
})

const AccountsResponse = dataEnvelope(z.object({ accounts: z.array(Account) }))

const ACCOUNT_COLUMNS =
  'account_number, account_name, account_class, account_group, account_type, ' +
  'normal_balance, is_system_account, is_active, description, default_vat_code, ' +
  'sru_code, sort_order'

registerEndpoint({
  operation: 'accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/accounts',
  summary: 'List chart-of-accounts entries (BAS chart).',
  description:
    'Returns every account in the company\'s chart of accounts, ordered by sort_order (the BAS canonical sequence). Filter by ?class=<1..8> (BAS account class — 1=assets, 2=equity/liabilities, 3=revenue, 4=cost of goods sold, 5=övriga externa kostnader (rents, supplies, services), 6=övriga externa kostnader (marketing, professional services, IT), 7=labour, 8=financial). Note: BAS 5xxx and 6xxx are both övriga externa kostnader but cover distinct subgroups — see the BAS chart for the canonical mapping. Pass ?active=false to include archived accounts.',
  useWhen:
    'You need account numbers and names to render verifikation tables, build a custom report, or look up the canonical BAS label for an account.',
  doNotUseFor:
    'Fetching balances — use the trial-balance report. Creating new accounts — this endpoint is read-only in v1 (use the dashboard).',
  pitfalls: [
    'account_number is a STRING — "1930", not 1930. The leading character can be 0 in non-BAS plans.',
    'is_system_account=true means the account was seeded by Accounted and cannot be archived or renamed.',
    'Default filter excludes archived accounts; pass ?active=false to include them.',
  ],
  example: {
    response: {
      data: {
        accounts: [
          {
            account_number: '1930',
            account_name: 'Företagskonto',
            account_class: 1,
            account_type: 'asset',
            normal_balance: 'debit',
            is_active: true,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: AccountsResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'accounts.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const Filters = z.object({
      class: z
        .string()
        .regex(/^[1-8]$/)
        .optional(),
      active: z.enum(['true', 'false']).optional(),
    })
    const parsed = Filters.safeParse({
      class: url.searchParams.get('class') ?? undefined,
      active: url.searchParams.get('active') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const f = parsed.data
    const activeOnly = f.active !== 'false'

    let query = ctx.supabase
      .from('chart_of_accounts')
      .select(ACCOUNT_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('sort_order', { ascending: true })

    if (activeOnly) query = query.eq('is_active', true)
    if (f.class) query = query.eq('account_class', parseInt(f.class, 10))

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    return ok({ accounts: data ?? [] }, { requestId: ctx.requestId })
  },
)
