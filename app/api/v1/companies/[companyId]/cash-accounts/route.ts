/**
 * GET /api/v1/companies/{companyId}/cash-accounts
 *
 * List the company's bank/cash accounts (cash_accounts) including the
 * bank-reported balance (booked + available) and when it was fetched.
 * The balance figures come from the PSD2 provider, not from the ledger.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { listForCompany } from '@/lib/cash-accounts/service'

const CashAccount = z.object({
  cash_account_id: z.string(),
  ledger_account: z.string(),
  name: z.string().nullable(),
  currency: z.string(),
  iban: z.string().nullable(),
  is_primary: z.boolean(),
  enabled: z.boolean(),
  source: z.enum(['enable_banking', 'manual', 'sie_import']),
  balance: z.number().nullable(),
  available_balance: z.number().nullable(),
  balance_updated_at: z.string().nullable(),
})

const CashAccountsResponse = dataEnvelope(
  z.object({ cash_accounts: z.array(CashAccount) }),
)

registerEndpoint({
  operation: 'cash-accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/cash-accounts',
  summary: 'List bank/cash accounts with the bank-reported balance.',
  description:
    'Returns the company\'s cash accounts (bank accounts, kassa) with their BAS ledger mapping and, for PSD2-connected accounts, the balance the bank itself reported at the last sync: balance (booked), available_balance, and balance_updated_at (when it was fetched). Pass ?enabled_only=true to return only accounts that sync.',
  useWhen:
    'You need the current bank balance per account (e.g. a covering decision before a payment run), or cash_account_id values to filter transaction listings.',
  doNotUseFor:
    'The bookkept 19xx balance: use the trial-balance or balance-sheet reports. The two legitimately differ (pending bookings, timing).',
  pitfalls: [
    'balance/available_balance are what the BANK reported, refreshed at most every 12h (PSD2 quota): check balance_updated_at before treating them as current.',
    'balance is null for manual and SIE-imported accounts, and for PSD2 accounts that have not completed a sync since connecting.',
    'available_balance is null when the bank reports no available balance type; that does not mean 0.',
  ],
  example: {
    response: {
      data: {
        cash_accounts: [
          {
            cash_account_id: 'ca_…',
            ledger_account: '1930',
            name: 'Företagskonto',
            currency: 'SEK',
            iban: 'SE4550000000058398257466',
            is_primary: true,
            enabled: true,
            source: 'enable_banking',
            balance: 125430.5,
            available_balance: 123930.5,
            balance_updated_at: '2026-09-01T05:12:44.000Z',
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CashAccountsResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'cash-accounts.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const Filters = z.object({ enabled_only: z.enum(['true', 'false']).optional() })
    const parsed = Filters.safeParse({
      enabled_only: url.searchParams.get('enabled_only') ?? undefined,
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

    try {
      const rows = await listForCompany(ctx.supabase, ctx.companyId!, {
        enabledOnly: parsed.data.enabled_only === 'true',
      })
      const cashAccounts = rows.map((row) => ({
        cash_account_id: row.id,
        ledger_account: row.ledger_account,
        name: row.name ?? null,
        currency: row.currency,
        iban: row.iban ?? null,
        is_primary: row.is_primary === true,
        enabled: row.enabled !== false,
        source: row.source,
        balance: row.balance ?? null,
        available_balance: row.available_balance ?? null,
        balance_updated_at: row.balance_updated_at ?? null,
      }))
      return ok({ cash_accounts: cashAccounts }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)
