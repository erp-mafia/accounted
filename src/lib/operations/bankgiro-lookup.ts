/**
 * Bankgiro Lookup through the machine doors (lib/payments/bankgiro-lookup.ts):
 * the name Bankgirot has registered for a bankgiro or plusgiro number (and
 * whether an OCR passes the creditor's check), and the giro numbers
 * registered to the company's own organisationsnummer. Reads only; the
 * dashboard routes under /api/payments call the same service.
 *
 * Premium at the provider, so the whole feature is behind
 * OPENPAYMENTS_BANKGIRO_LOOKUP=true: switched off, every answer is
 * `enabled: false` and nothing is asked. A lookup is advice, never a gate: a
 * provider refusal is a typed `available: false`, never an error.
 */
import { z } from 'zod'
import {
  LOOKUP_UNAVAILABLE_REASONS,
  lookupCompanyGiroNumbers,
  lookupCreditorName,
  type CompanyGiroNumbersLookup,
  type CreditorNameLookup,
} from '@/lib/payments/bankgiro-lookup'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const GIRO_TYPE = z.enum(['bankgiro', 'plusgiro']).describe('Which kind of giro number `giro` is.')

const REASON = z
  .enum(LOOKUP_UNAVAILABLE_REASONS)
  .nullable()
  .describe(
    'Why there is no answer although the lookup is enabled: premium_not_enabled (the provider has not opened the product for this ' +
      'service), provider_refused (the provider failed or refused; try later), not_found (Bankgirot knows no such giro, or no ' +
      'registration for the company), invalid_number (the giro fails its check digit), org_number_missing (the company has no ' +
      'organisationsnummer). Null when available is true, or when enabled is false.',
  )

const Warning = z.object({
  code: z.string().describe("The provider's message code, e.g. OCR_REF_INVALID."),
  text: z.string().nullable(),
})

export const creditorLookupInputSchema = z.object({
  giro: z
    .string()
    .trim()
    .min(5)
    .max(40)
    .describe('The bankgiro or plusgiro number, as typed or stored (digits, spaces and dashes).'),
  type: GIRO_TYPE,
  ocr: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("The payment's OCR reference, when it has one: the creditor's OCR check runs on it and ocr_valid answers."),
  invoice_ref: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("The payment's free reference (the invoice number) when it has no OCR. Ignored when ocr is given."),
})

export const creditorLookupOutputSchema = z.object({
  enabled: z.boolean().describe('False when the installation has not switched the premium lookups on: nothing was asked.'),
  available: z.boolean().describe('True when Bankgirot answered with a name.'),
  reason: REASON,
  creditor_name: z.string().nullable().describe('The name Bankgirot has registered for the giro number, when available.'),
  ocr_valid: z
    .boolean()
    .nullable()
    .describe('With an ocr: whether the creditor accepts it. Null when no OCR was given or nothing is available.'),
  warnings: z.array(Warning).describe("The provider's warnings on a successful answer, verbatim codes; [] when none."),
})

export type CreditorLookupOutput = z.infer<typeof creditorLookupOutputSchema>

/** The service's answer in the door's shape: flat, so a client that cached the schema keeps parsing. */
export function creditorLookupToOutput(lookup: CreditorNameLookup): CreditorLookupOutput {
  if (!lookup.enabled) return { enabled: false, available: false, reason: null, creditor_name: null, ocr_valid: null, warnings: [] }
  if (!lookup.available) return { enabled: true, available: false, reason: lookup.reason, creditor_name: null, ocr_valid: null, warnings: [] }
  return { enabled: true, available: true, reason: null, creditor_name: lookup.creditorName, ocr_valid: lookup.ocrValid, warnings: lookup.warnings }
}

export const paymentsLookupCreditor = defineOperation({
  id: 'payments.lookup-creditor',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The name Bankgirot has registered for a bankgiro or plusgiro number, and whether an OCR passes its check.',
    description:
      "Asks Bankgirot (through the payment provider's premium Bankgiro Lookup) which name is registered for a bankgiro or plusgiro " +
      'number before money goes there: the check against invoice fraud and typos. With the payment\'s OCR, ocr_valid says whether ' +
      'the creditor accepts it. Enabled only when the installation has switched the lookups on (OPENPAYMENTS_BANKGIRO_LOOKUP); ' +
      'otherwise enabled is false and nothing is asked. Advice, never a gate: a refusal is a typed reason, and the payment may ' +
      'still be prepared.',
    useWhen:
      'Before paying a supplier for the first time, when an invoice states another account than the supplier card, or when a new ' +
      'supplier card carries a giro: compare creditor_name with the supplier name.',
    doNotUseFor: "The company's own giro numbers (GET /payments/giro-numbers). Bank accounts (clearing + account) or IBANs: Bankgirot does not register them.",
    pitfalls: [
      'Every enabled call may cost a premium fee at the provider; answers are cached for ten minutes per company and question.',
      'A name that differs from the supplier card is a reason for a person to check with the supplier, not proof of fraud: companies register trade names.',
      'reason not_found means Bankgirot knows no such number: check the digits before paying.',
    ],
    example: {
      request: { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233' },
      response: {
        data: { enabled: true, available: true, reason: null, creditor_name: 'Derome Bygg AB', ocr_valid: true, warnings: [] },
        meta: META,
      },
    },
  },
  input: creditorLookupInputSchema,
  output: creditorLookupOutputSchema,
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payments/creditor-lookup' },
  mcp: {
    name: 'gnubok_lookup_bankgiro_creditor',
    title: 'Lookup Bankgiro Creditor',
    description:
      'The name Bankgirot has registered for a bankgiro or plusgiro number, and whether the payment\'s OCR passes the creditor\'s ' +
      'check: the fraud and typo check before a first payment to an account. Behind an installation flag; a refusal is a typed reason.',
    visibility: 'search',
    keywords: [
      'bankgiro',
      'plusgiro',
      'bankgirot',
      'mottagare',
      'betalningsmottagare',
      'kontrollera bankgiro',
      'vem äger bankgironumret',
      'fakturabedrägeri',
      'ocr kontroll',
      'leverantör konto',
    ],
  },
  run: async (ctx, input) => ({
    ok: true,
    data: creditorLookupToOutput(await lookupCreditorName(ctx, { giro: input.giro, type: input.type, ocr: input.ocr ?? null, invoiceRef: input.invoice_ref ?? null })),
  }),
})

const RegisteredGiro = z.object({
  number: z.string().describe('As Bankgirot gives it, e.g. "5050-1055".'),
  type: GIRO_TYPE,
  name: z.string().nullable().describe('The name registered for the number, when Bankgirot gives one.'),
})

export const companyGiroNumbersOutputSchema = z.object({
  enabled: z.boolean().describe('False when the installation has not switched the premium lookups on: nothing was asked.'),
  available: z.boolean().describe('True when Bankgirot answered (possibly with an empty list).'),
  reason: REASON,
  giro_numbers: z.array(RegisteredGiro).describe("The giro numbers registered to the company's organisationsnummer; [] when none or not available."),
})

export type CompanyGiroNumbersOutput = z.infer<typeof companyGiroNumbersOutputSchema>

export function companyGiroNumbersToOutput(lookup: CompanyGiroNumbersLookup): CompanyGiroNumbersOutput {
  if (!lookup.enabled) return { enabled: false, available: false, reason: null, giro_numbers: [] }
  if (!lookup.available) return { enabled: true, available: false, reason: lookup.reason, giro_numbers: [] }
  return { enabled: true, available: true, reason: null, giro_numbers: lookup.giroNumbers }
}

export const paymentsCompanyGiroNumbers = defineOperation({
  id: 'payments.company-giro-numbers',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: "The bankgiro and plusgiro numbers Bankgirot has registered to the company's own organisationsnummer.",
    description:
      "Asks Bankgirot (through the payment provider's premium Bankgiro Lookup) which giro numbers are registered to the company, so " +
      'the invoice payee (the bankgiro printed on the company\'s invoices) can be picked from the registry instead of typed. Enabled ' +
      'only when the installation has switched the lookups on (OPENPAYMENTS_BANKGIRO_LOOKUP); otherwise enabled is false and nothing ' +
      'is asked.',
    useWhen: 'Setting up or checking the bankgiro the company prints on its invoices (cash account payee details).',
    doNotUseFor: "A supplier's giro (GET /payments/creditor-lookup). Reading the payee details already saved (GET /cash-accounts).",
    pitfalls: [
      'Every enabled call may cost a premium fee at the provider; the answer is cached for ten minutes per company.',
      'An empty list with available true means Bankgirot has no giro registered to this organisationsnummer.',
    ],
    example: {
      response: {
        data: { enabled: true, available: true, reason: null, giro_numbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }] },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: companyGiroNumbersOutputSchema,
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payments/giro-numbers' },
  mcp: {
    name: 'gnubok_list_company_giro_numbers',
    title: 'List Company Giro Numbers',
    description:
      "The bankgiro and plusgiro numbers Bankgirot has registered to the company's own organisationsnummer, for the invoice payee " +
      'setup. Behind an installation flag; a refusal is a typed reason.',
    visibility: 'search',
    keywords: ['eget bankgiro', 'företagets bankgiro', 'bankgironummer', 'plusgironummer', 'fakturans bankgiro', 'betalningsmottagare faktura', 'bankgirot register'],
  },
  run: async (ctx) => ({ ok: true, data: companyGiroNumbersToOutput(await lookupCompanyGiroNumbers(ctx)) }),
})
