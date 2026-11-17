/**
 * The skattekonto's ledger account over v1 (PH 175, issue #50): 1630 for
 * every company, or 2012 in eget kapital for an enskild firma that runs the
 * skattekonto there.
 *
 *   settings.get-skattekonto-account     the account every skattekonto reader
 *                                        uses, the stored choice, the choices
 *                                        and the balance on each
 *   settings.update-skattekonto-account  store the choice (high: booking,
 *                                        matching and the reconciliation read
 *                                        the new account from then on)
 *
 * Rules live in lib/skatteverket/skattekonto-account-service.ts, shared with
 * the dashboard's /api/settings/skattekonto-account. Changing the account
 * moves nothing in the ledger (BFL 5 kap. 5 §: a posted verifikat is never
 * edited); what is left on the old account is the user's transfer, drafted
 * by the dashboard or booked with POST /journal-entries.
 */
import { z } from 'zod'
import {
  SKATTEKONTO_ACCOUNT_DEFAULT as DEFAULT,
  SKATTEKONTO_ACCOUNT_EQUITY as EQUITY,
  SKATTEKONTO_LEDGER_ACCOUNTS,
} from '@/lib/skatteverket/skattekonto-account'
import { getSkattekontoAccountState, setSkattekontoAccount } from '@/lib/skatteverket/skattekonto-account-service'
import { defineOperation } from './types'

const PATH = '/api/v1/companies/:companyId/settings/skattekonto-account'
const META = { request_id: 'req_...', api_version: '2026-05-12' }

const Account = z.enum(SKATTEKONTO_LEDGER_ACCOUNTS)

const SkattekontoAccountState = z.object({
  entity_type: z.string().describe('The company\'s legal form; only an enskild_firma may choose 2012.'),
  account: Account.describe('The account every skattekonto reader uses now: booking, matching and the reconciliation.'),
  chosen: Account.nullable().describe('The stored choice; null when never chosen (the company then runs 1630).'),
  choices: z.array(Account).describe('The accounts this legal form may choose, the default first.'),
  books_suggest: Account.nullable().describe(
    'What the books say: 1630 or 2012 when skattekonto lines sit on that account, null with nothing booked on either.',
  ),
  as_of: z.string().describe('The date the balances are read through (YYYY-MM-DD, today in Sweden).'),
  balances: z
    .array(z.object({ account: Account, balance: z.number().describe('Debit minus credit, kr, from the latest opening balance.') }))
    .describe('The balance on each choosable account, so a change shows what stays on the old one.'),
})

const STATE_EXAMPLE = {
  entity_type: 'enskild_firma',
  account: DEFAULT,
  chosen: null,
  choices: [DEFAULT, EQUITY],
  books_suggest: DEFAULT,
  as_of: '2026-10-26',
  balances: [
    { account: DEFAULT, balance: 1250 },
    { account: EQUITY, balance: 0 },
  ],
}

export const settingsGetSkattekontoAccount = defineOperation({
  id: 'settings.get-skattekonto-account',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read which ledger account the skattekonto runs on (1630, or 2012 for an enskild firma).',
    description:
      'Returns the account every skattekonto reader uses now (booking skattekonto rows, matching them to verifikat, the skattekonto reconciliation), the stored choice, the accounts the legal form may choose, what the books suggest and the balance on each choosable account.',
    useWhen: 'Before booking skattekonto rows or a payment to Skatteverket by hand, or before changing the account.',
    doNotUseFor: 'The skattekonto events themselves (the reconciliation and skattekonto sync endpoints).',
    pitfalls: [
      'chosen is null for a company that never chose: it runs 1630.',
      'balances read the ledger through as_of; a change of account moves none of it.',
    ],
    example: { response: { data: STATE_EXAMPLE, meta: META } },
  },
  input: z.object({}),
  output: SkattekontoAccountState,
  errorCodes: ['NOT_FOUND'],
  http: { method: 'GET', path: PATH },
  mcp: {
    name: 'gnubok_get_tax_account_ledger_setting',
    title: 'Get Tax Account Ledger Setting',
    description:
      'Which ledger account the skattekonto runs on (1630, or 2012 for an enskild firma that chose it): the account in use, the stored choice, what the legal form may choose, what the books suggest and the balance on each. Call before booking skattekonto rows or a tax payment by hand.',
    keywords: ['1630 eller 2012', 'vilket konto skattekontot bokförs på', 'skattekontots bokföringskonto', 'konto för skattekontot'],
  },
  run: async (ctx) => getSkattekontoAccountState(ctx),
})

export const settingsUpdateSkattekontoAccount = defineOperation({
  id: 'settings.update-skattekonto-account',
  kind: 'write',
  scope: 'companies:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Choose the ledger account the skattekonto runs on: 1630, or 2012 in equity for an enskild firma.',
    description:
      'Stores the choice. From then on booking skattekonto rows, matching them to verifikat and the skattekonto reconciliation use the new account; 2012 is added to the chart (BAS K1 name, eget kapital) when missing. Nothing in the ledger moves: posted verifikat stay on the account they were booked on, and the response says what is left on the previous account (left_on_previous) for a transfer verifikat the user books. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
    useWhen:
      'An enskild firma keeps its skattekonto in eget kapital on 2012 (the firm shares the skattekonto with the owner), or a company moves back to 1630.',
    doNotUseFor:
      'Moving the balance itself (book the transfer with POST /journal-entries: debit the new account and credit the old one, or the reverse), or the tax profile (PATCH /settings/tax-profile).',
    pitfalls: [
      'Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.',
      '2012 is allowed for an enskild firma only; any other account, or 2012 for another legal form, is 400 SKATTEKONTO_ACCOUNT_NOT_ALLOWED with details.allowed.',
      'Company-authored booking templates and mapping rules that name 1630 keep 1630: review them after a change.',
      'left_on_previous is the old account\'s balance when it is not zero: the skattekonto reconciliation reads only the new account, so book the transfer.',
    ],
    example: {
      request: { account: EQUITY },
      response: {
        data: {
          state: { ...STATE_EXAMPLE, account: EQUITY, chosen: EQUITY },
          previous_account: DEFAULT,
          left_on_previous: 1250,
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      account: Account.describe('1630 Avräkning för skatter och avgifter, or 2012 (enskild firma only).'),
    })
    .strict(),
  output: z.object({
    state: SkattekontoAccountState,
    previous_account: Account.describe('The account in use before this call.'),
    left_on_previous: z
      .number()
      .nullable()
      .describe('The previous account\'s balance when it is not zero (what a transfer verifikat would move), else null.'),
  }),
  errorCodes: ['FORBIDDEN', 'NOT_FOUND', 'SKATTEKONTO_ACCOUNT_NOT_ALLOWED'],
  http: { method: 'PATCH', path: PATH },
  run: async (ctx, input, { dryRun }) => setSkattekontoAccount(ctx, input.account, { dryRun }),
})
