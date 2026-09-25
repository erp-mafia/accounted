/**
 * Cash account operations: the company's bank and cash accounts
 * (cash_accounts): create one by hand, edit it, make it the primary, choose
 * the default payee account per invoice currency. Listing stays the
 * hand-written GET /cash-accounts route and gnubok_list_cash_accounts.
 * Rules live in lib/cash-accounts/manage.ts.
 *
 * The success payload is a curated account shape, not the raw row: balance
 * and available_balance are left out (the bank-reported figures belong to
 * the list endpoint, and the ledger balance to the reports).
 */
import { z } from 'zod'
import type { CashAccount } from '@/types'
import {
  CreateCashAccountSchema,
  CurrencySchema,
  SetInvoicePayeeDefaultSchema,
  UpdateCashAccountFieldsSchema,
} from '@/lib/api/schemas'
import {
  createCashAccount,
  setCashAccountPayeeDefault,
  setPrimaryCashAccount,
  updateCashAccount,
} from '@/lib/cash-accounts/manage'
import type { OperationOutcome } from './types'
import { defineOperation } from './types'

const Payee = z.object({
  bank_name: z.string().nullable(),
  clearing_number: z.string().nullable(),
  account_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  swish: z.string().nullable(),
  iban: z.string().nullable().describe('The IBAN printed on invoices (may differ from the bank identity iban).'),
  bic: z.string().nullable(),
  bank_code: z.string().nullable(),
  foreign_account_number: z.string().nullable(),
})

const CashAccountOut = z.object({
  cash_account_id: z.string().uuid(),
  ledger_account: z.string().describe('BAS 19xx account the bank account books on, as a string.'),
  name: z.string().nullable(),
  currency: z.string(),
  iban: z.string().nullable().describe('The bank identity IBAN (written by the bank sync).'),
  source: z.enum(['enable_banking', 'manual', 'sie_import']),
  bank_connected: z.boolean().describe('True when a bank connection holds the account.'),
  enabled: z.boolean(),
  is_primary: z.boolean(),
  voucher_series: z.string().nullable().describe('Verifikationsserie override; null follows the per-source default.'),
  invoice_payee: z.boolean().describe('Whether the account may be printed as payee on customer invoices.'),
  payee: Payee,
})

type CashAccountOutput = z.infer<typeof CashAccountOut>

function toPublic(row: CashAccount): CashAccountOutput {
  return {
    cash_account_id: row.id,
    ledger_account: row.ledger_account,
    name: row.name ?? null,
    currency: row.currency,
    iban: row.iban ?? null,
    source: row.source,
    bank_connected: row.bank_connection_id != null,
    enabled: row.enabled !== false,
    is_primary: row.is_primary === true,
    voucher_series: row.voucher_series ?? null,
    invoice_payee: row.invoice_payee === true,
    payee: {
      bank_name: row.bank_name ?? null,
      clearing_number: row.clearing_number ?? null,
      account_number: row.account_number ?? null,
      bankgiro: row.bankgiro ?? null,
      plusgiro: row.plusgiro ?? null,
      swish: row.swish ?? null,
      iban: row.payee_iban ?? null,
      bic: row.bic ?? null,
      bank_code: row.bank_code ?? null,
      foreign_account_number: row.foreign_account_number ?? null,
    },
  }
}

/** Map a successful write outcome's row to the public shape. */
function publicOutcome(outcome: OperationOutcome<CashAccount>): OperationOutcome<CashAccountOutput> {
  if (!outcome.ok || outcome.dryRun) return outcome
  return { ...outcome, data: toPublic(outcome.data) }
}

const CASH_ACCOUNT_ID = z
  .string()
  .uuid()
  .describe('The cash account id (cash_account_id from GET /cash-accounts), not its ledger account.')

const EXAMPLE_ACCOUNT = {
  cash_account_id: '7f3a…',
  ledger_account: '1931',
  name: 'Sparkonto',
  currency: 'SEK',
  iban: 'SE4550000000058398257466',
  source: 'manual',
  bank_connected: false,
  enabled: true,
  is_primary: false,
  voucher_series: null,
  invoice_payee: true,
  payee: {
    bank_name: 'SEB',
    clearing_number: null,
    account_number: null,
    bankgiro: '5050-1234',
    plusgiro: null,
    swish: null,
    iban: 'SE4550000000058398257466',
    bic: 'ESSESESS',
    bank_code: null,
    foreign_account_number: null,
  },
}

const META = { request_id: 'req_…', api_version: '2026-05-12' }

export const cashAccountsCreate = defineOperation({
  id: 'cash-accounts.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Create a bank account by hand (no bank connection), with the payee details invoices print.',
    description:
      'Adds a manual bank account (cash_accounts, source manual) in a currency, on the next free BAS 19xx ledger account for that currency unless ledger_account (1920-1999) is given, and adds that account to the chart if missing. payee holds what customer invoices print (bankgiro, IBAN, ...); invoice_payee defaults to true. A later bank connection with the same IBAN takes this row over in place. Owner/admin only. Idempotent. Dry-runnable.',
    useWhen:
      'The company has a bank account that is not connected through the bank integration (a savings account, a currency account, a bank without PSD2) and it should appear in Konton, the booking flows or on invoices.',
    doNotUseFor:
      'Connecting a bank (the bank connection flow creates its own accounts), changing an existing account (PATCH /cash-accounts/{id}) or choosing which account invoices print by default (PUT /cash-accounts/payee-defaults).',
    pitfalls: [
      'An IBAN another account of the company already carries returns 409 CASH_ACCOUNT_IBAN_DUPLICATE: one physical account must exist once.',
      'A ledger_account another cash account holds returns 409 CASH_ACCOUNT_LEDGER_TAKEN; omit it to get the next free one.',
      'ledger_account is a STRING in 1920-1999 ("1931"), never a number, and never a till (1910-1919) or a PSP clearing account.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
      'Creating an account does not make it the default payee: set that with PUT /cash-accounts/payee-defaults.',
    ],
    example: {
      request: { name: 'Sparkonto', currency: 'SEK', payee: { bank_name: 'SEB', bankgiro: '5050-1234' } },
      response: { data: EXAMPLE_ACCOUNT, meta: META },
    },
  },
  input: CreateCashAccountSchema,
  output: CashAccountOut,
  errorCodes: ['FORBIDDEN', 'CASH_ACCOUNT_IBAN_DUPLICATE', 'CASH_ACCOUNT_LEDGER_TAKEN', 'CASH_ACCOUNT_NO_FREE_LEDGER'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/cash-accounts' },
  mcp: {
    name: 'gnubok_create_cash_account',
    title: 'Create Cash Account',
    description:
      'Stage a manual bank account (no bank connection) with its payee details; it gets the next free 19xx ledger account unless ledger_account is given. Refused for an IBAN the company already has. Owner/admin only.',
    keywords: ['nytt bankkonto', 'lägg till bankkonto', 'sparkonto', 'valutakonto', 'manuellt bankkonto', 'kassakonto'],
    stage: { pendingType: 'create_cash_account', title: (input) => `Nytt bankkonto: ${String(input.name)}` },
  },
  run: async (ctx, input, { dryRun }) => publicOutcome(await createCashAccount(ctx, input, { dryRun })),
})

export const cashAccountsUpdate = defineOperation({
  id: 'cash-accounts.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Edit a bank account: verifikationsserie, payee details, name, or turn it on/off.',
    description:
      'Sparse update of one cash account. voucher_series (one letter A-Z, null clears) sets the verifikationsserie for entries booked from the account. The payee fields (bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, bank_code, foreign_account_number), name and invoice_payee decide what customer invoices print; "" or null clears a field. enabled=false hides an account no bank connection holds from Konton and the booking flows. The ledger account and the primary flag are not editable here. Idempotent. Dry-runnable.',
    useWhen:
      'The company changes bank details customers pay to, wants its own voucher series per bank account, or stops using a manually added account.',
    doNotUseFor:
      'Making an account the primary (POST /cash-accounts/{id}/set-primary), choosing the default payee per currency (PUT /cash-accounts/payee-defaults) or moving a transaction to another account.',
    pitfalls: [
      'Payee fields, name, invoice_payee and enabled are owner/admin only (403 FORBIDDEN); voucher_series alone is open to any writer.',
      'Payee fields on a PSP clearing account or a till return 400 INVOICE_PAYEE_ACCOUNT_INVALID: only 1920-1999 bank accounts print on invoices.',
      'enabled on an account a bank connection holds returns 409 CASH_ACCOUNT_ENABLED_BANK_MANAGED; disabling the primary returns 400 CASH_ACCOUNT_DISABLE_PRIMARY, and one with unbooked transactions 400 CASH_ACCOUNT_DISABLE_UNRESOLVED.',
      'An iban another account already carries returns 409 CASH_ACCOUNT_IBAN_DUPLICATE.',
      'Changing voucher_series only affects entries booked afterwards; nothing posted is renumbered.',
    ],
    example: {
      request: { bankgiro: '5050-1234', invoice_payee: true },
      response: { data: EXAMPLE_ACCOUNT, meta: META },
    },
  },
  input: UpdateCashAccountFieldsSchema.extend({ cash_account_id: CASH_ACCOUNT_ID }).refine(
    (body) => Object.keys(body).some((key) => key !== 'cash_account_id'),
    { message: 'Send at least one field to update.' },
  ),
  output: CashAccountOut,
  errorCodes: [
    'CASH_ACCOUNT_NOT_FOUND',
    'FORBIDDEN',
    'INVOICE_PAYEE_ACCOUNT_INVALID',
    'CASH_ACCOUNT_IBAN_DUPLICATE',
    'CASH_ACCOUNT_ENABLED_BANK_MANAGED',
    'CASH_ACCOUNT_DISABLE_PRIMARY',
    'CASH_ACCOUNT_DISABLE_UNRESOLVED',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/cash-accounts/:id',
    pathParams: { id: 'cash_account_id' },
  },
  mcp: {
    name: 'gnubok_update_cash_account',
    title: 'Update Cash Account',
    description:
      'Stage an edit of a bank account: voucher_series, the payee details invoices print (bankgiro, IBAN, ...), name, invoice_payee, or enabled. Payee and enabled changes are owner/admin only. Not the ledger account or the primary.',
    keywords: ['ändra bankkonto', 'bankgiro', 'betaluppgifter', 'verifikationsserie bankkonto', 'stäng av bankkonto'],
    stage: { pendingType: 'update_cash_account', title: () => 'Ändra bankkonto' },
  },
  run: async (ctx, { cash_account_id, ...changes }, { dryRun }) =>
    publicOutcome(await updateCashAccount(ctx, cash_account_id, changes, { dryRun })),
})

export const cashAccountsSetPrimary = defineOperation({
  id: 'cash-accounts.set-primary',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Make a bank account the company\'s primary.',
    description:
      'The primary is where bookings land when nothing else says which bank account they belong to: the skattekonto counter leg and transactions with no cash account. It must be an enabled SEK giro or bank account (BAS 1920-1999). The flag moves in one transaction and the change is logged with the acting user. Only bookings made afterwards follow the new primary; nothing posted changes. Owner/admin only. Idempotent. Dry-runnable.',
    useWhen: 'The company\'s main business account is not the one marked primary (typically the seeded 1930).',
    doNotUseFor: 'Choosing which account invoices print (PUT /cash-accounts/payee-defaults) or moving transactions between accounts.',
    pitfalls: [
      'A disabled, non-SEK or non-bank account (till, PSP clearing) returns 400 CASH_ACCOUNT_PRIMARY_INELIGIBLE with details.reason.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
      'Takes no body; the account id is in the path.',
    ],
    example: {
      response: { data: { ...EXAMPLE_ACCOUNT, is_primary: true }, meta: META },
    },
  },
  input: z.object({ cash_account_id: CASH_ACCOUNT_ID }),
  output: CashAccountOut,
  errorCodes: ['CASH_ACCOUNT_NOT_FOUND', 'FORBIDDEN', 'CASH_ACCOUNT_PRIMARY_INELIGIBLE'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/cash-accounts/:id/set-primary',
    pathParams: { id: 'cash_account_id' },
  },
  mcp: {
    name: 'gnubok_set_primary_cash_account',
    title: 'Set Primary Cash Account',
    description:
      'Stage making a bank account the company\'s primary (skattekonto counter leg, owner of transactions with no account). Must be an enabled SEK bank account 1920-1999. Only later bookings follow; owner/admin only.',
    keywords: ['primärt bankkonto', 'huvudkonto', 'gör primärt', 'byt huvudbankkonto'],
    stage: { pendingType: 'set_primary_cash_account', title: () => 'Byt primärt bankkonto' },
  },
  run: async (ctx, { cash_account_id }, { dryRun }) =>
    publicOutcome(await setPrimaryCashAccount(ctx, cash_account_id, { dryRun })),
})

const PayeeDefault = z.object({
  currency: z.string(),
  cash_account_id: z.string().uuid(),
})

export const cashAccountsSetPayeeDefault = defineOperation({
  id: 'cash-accounts.set-payee-default',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Choose which bank account invoices in a currency tell the customer to pay to.',
    description:
      'Sets (or clears with cash_account_id null) the default payee account for one currency: every new invoice in that currency prints this account\'s payment details unless the invoice picks another. The account must be a bank account (1920-1999), enabled, flagged invoice_payee, and carry what the currency needs (an IBAN for anything but SEK). Answers every per-currency default after the change. Owner/admin only. Idempotent. Dry-runnable.',
    useWhen: 'The company wants EUR invoices paid to its EUR account, or changes which SEK account customers pay to.',
    doNotUseFor: 'Editing the bank details themselves (PATCH /cash-accounts/{id}) or the primary account (set-primary).',
    pitfalls: [
      'An account that cannot print for the currency returns 400 INVOICE_PAYEE_ACCOUNT_INVALID with details.reason (not_bank_account, disabled, not_payee, unusable_for_currency).',
      'Invoices already sent keep the payment details they were sent with.',
      'Owner or admin only: a member key gets 403 FORBIDDEN.',
    ],
    example: {
      request: { currency: 'EUR', cash_account_id: '7f3a…' },
      response: { data: { defaults: [{ currency: 'EUR', cash_account_id: '7f3a…' }] }, meta: META },
    },
  },
  input: SetInvoicePayeeDefaultSchema.extend({
    currency: CurrencySchema.describe('Invoice currency, e.g. "SEK" or "EUR".'),
    cash_account_id: CASH_ACCOUNT_ID.nullable().describe('The account to print, or null to clear the default.'),
  }),
  output: z.object({ defaults: z.array(PayeeDefault) }),
  errorCodes: ['CASH_ACCOUNT_NOT_FOUND', 'FORBIDDEN', 'INVOICE_PAYEE_ACCOUNT_INVALID'],
  http: { method: 'PUT', path: '/api/v1/companies/:companyId/cash-accounts/payee-defaults' },
  mcp: {
    name: 'gnubok_set_invoice_payee_default',
    title: 'Set Invoice Payee Default',
    description:
      'Stage choosing which bank account invoices in a currency print as payee (null clears). The account must be an enabled 1920-1999 bank account flagged invoice_payee with details for the currency. Owner/admin only.',
    keywords: ['betalningsmottagare', 'fakturans bankkonto', 'standardkonto faktura', 'betala till'],
    stage: {
      pendingType: 'set_invoice_payee_default',
      title: (input) => `Betalkonto på fakturor i ${String(input.currency)}`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await setCashAccountPayeeDefault(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        defaults: outcome.data.defaults.map((d) => ({ currency: d.currency, cash_account_id: d.cash_account_id })),
      },
    }
  },
})
