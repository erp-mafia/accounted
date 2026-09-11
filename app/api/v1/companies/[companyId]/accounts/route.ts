/**
 * GET /api/v1/companies/{companyId}/accounts
 *
 * List the company's chart of accounts (kontoplan). Filter by ?class=0..9
 * (the first digit of account_number) and ?active=false (include
 * deactivated accounts). Sorted by account_number, which is the BAS sequence:
 * agents can render the BAS hierarchy directly from this.
 */
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { AccountVatTreatmentSchema } from '@/lib/api/schemas'

const Account = z.object({
  account_number: z.string(),
  account_name: z.string(),
  // The first digit of account_number. BAS uses 1-8; a chart imported from
  // another system can carry class 9 (internal accounts).
  account_class: z.number().int().min(0).max(9),
  account_group: z.string(),
  // Mirrors chart_of_accounts_account_type_check. The shared
  // AccountTypeSchema lacks untaxed_reserves, so it cannot describe reads.
  account_type: z.enum(['asset', 'equity', 'liability', 'untaxed_reserves', 'revenue', 'expense']),
  normal_balance: z.enum(['debit', 'credit']),
  is_system_account: z.boolean(),
  is_active: z.boolean(),
  description: z.string().nullable(),
  default_vat_code: z.string().nullable(),
  default_vat_rate: z.number().nullable(),
  default_vat_treatment: AccountVatTreatmentSchema.nullable(),
  sru_code: z.string().nullable(),
  // The column is nullable and the import paths write NULL for a
  // non-numeric account number.
  sort_order: z.number().int().nullable(),
})

const AccountsResponse = dataEnvelope(z.object({ accounts: z.array(Account) }))

const ACCOUNT_COLUMNS =
  'account_number, account_name, account_class, account_group, account_type, ' +
  'normal_balance, is_system_account, is_active, description, default_vat_code, ' +
  'default_vat_rate, default_vat_treatment, sru_code, sort_order'

registerEndpoint({
  operation: 'accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/accounts',
  summary: 'List chart-of-accounts entries (BAS chart).',
  description:
    'Returns the company\'s own chart of accounts (kontoplan), ordered by account_number, which is the BAS sequence (a longer sub-account number such as 19301 sorts directly after 1930). This is not the full BAS 2026 catalogue: a new company starts with a small set of accounts seeded for its company form, and standard BAS accounts join the chart when the user activates them, when an import brings them in, or automatically the first time a verifikat posts to one. Filter with ?class=<0-9>, the first digit of account_number: 1 assets; 2 equity, untaxed reserves and liabilities; 3 operating revenue; 4 goods, materials and subcontracted services; 5 external expenses for premises, leasing, energy, consumables, repairs, vehicles, freight, travel, and advertising and PR; 6 other external expenses such as selling costs, office supplies, telecom, insurance, administration, accounting, IT and consulting services, and hired staff; 7 personnel costs, plus write-downs and depreciation (77xx-78xx); 8 financial items, year-end appropriations (88xx), and tax and the year\'s result (89xx). Class 9 appears only on internal accounts carried over from an imported chart. Only active accounts are returned by default; pass ?active=false to include deactivated ones.',
  useWhen:
    'You need account numbers and names to render verifikation tables, build a custom report, check that an account is active before booking to it, or look up an account\'s type, normal balance, SRU code or VAT defaults.',
  doNotUseFor:
    'Fetching balances: use the trial-balance report. Creating, renaming or deactivating accounts: v1 has no account write endpoint. Use the Kontoplan (chart of accounts) page in the app, or the MCP tools accounted_create_account and accounted_update_account, which stage the change for approval.',
  pitfalls: [
    'account_number is a STRING: "1930", not 1930. BAS numbers have four digits; a chart imported from another system can also carry longer sub-account numbers such as "19301".',
    'An account missing from this list is not necessarily unusable. Posting to a standard BAS 2026 account that is not in the chart adds it automatically; posting to a deactivated account, or to a non-BAS number the chart does not contain, fails with ACCOUNTS_NOT_IN_CHART.',
    'is_system_account=true marks the accounts seeded when the company was created (such as 1510, 1930, 2440, 2611 and 3001). They cannot be deleted and bulk deactivation skips them, but they can still be renamed and deactivated one at a time.',
    'normal_balance belongs to the account, not to account_type: contra accounts go against their type, such as 1219 (accumulated depreciation, an asset with a credit balance) and 3730 (discounts given, revenue with a debit balance).',
    'default_vat_rate is a fraction (0, 0.06, 0.12 or 0.25), not a percentage. default_vat_treatment overrides the built-in BAS mapping for the momsdeklaration and is null unless someone set it; it can only be set on class 3 (sales treatments) and classes 4-6 (reverse-charge purchase treatments).',
    'sort_order is a stored display hint, not a sequence to rely on: every account seeded at company creation carries 0. The list already comes in BAS order.',
    'Deactivated accounts are excluded by default; pass ?active=false to include them. A deactivated account keeps its history and balances but cannot be used on new verifikat.',
  ],
  example: {
    response: {
      data: {
        accounts: [
          {
            account_number: '1930',
            account_name: 'Företagskonto / checkkonto',
            account_class: 1,
            account_group: '19',
            account_type: 'asset',
            normal_balance: 'debit',
            is_system_account: true,
            is_active: true,
            description: null,
            default_vat_code: null,
            default_vat_rate: null,
            default_vat_treatment: null,
            sru_code: '7281',
            sort_order: 0,
          },
          {
            account_number: '3001',
            account_name: 'Försäljning inom Sverige, 25 % moms',
            account_class: 3,
            account_group: '30',
            account_type: 'revenue',
            normal_balance: 'credit',
            is_system_account: true,
            is_active: true,
            description: null,
            default_vat_code: null,
            default_vat_rate: 0.25,
            default_vat_treatment: null,
            sru_code: '7410',
            sort_order: 0,
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
        .regex(/^[0-9]$/)
        .optional(),
      active: z.enum(['true', 'false']).optional(),
    })
    const parsed = Filters.safeParse({
      class: url.searchParams.get('class') ?? undefined,
      active: url.searchParams.get('active') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const f = parsed.data
    const activeOnly = f.active !== 'false'

    // Paginated (fetchAllRows): PostgREST silently caps un-ranged selects at
    // 1000 rows and a full BAS 2026 chart holds ~1290 accounts. Paging is on
    // the unique account_number (fetchAllRows ordering invariant), and that
    // order is also the documented response order: account_number IS the BAS
    // sequence. sort_order is not: every seeded account carries 0, so sorting
    // by it put the seeded block ahead of everything else.
    type AccountRow = {
      account_number: string
      [key: string]: unknown
    }
    let accounts: AccountRow[]
    try {
      accounts = await fetchAllRows<AccountRow>(({ from, to }) => {
        let query = ctx.supabase
          .from('chart_of_accounts')
          .select(ACCOUNT_COLUMNS)
          .eq('company_id', ctx.companyId!)
        if (activeOnly) query = query.eq('is_active', true)
        if (f.class) query = query.eq('account_class', parseInt(f.class, 10))
        // The concatenated ACCOUNT_COLUMNS string defeats supabase-js's
        // template-literal column parser, so the row type is asserted here.
        return query.order('account_number', { ascending: true }).range(from, to) as unknown as PromiseLike<{
          data: AccountRow[] | null
          error: { message: string } | null
        }>
      })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    return ok({ accounts }, { requestId: ctx.requestId })
  },
)
