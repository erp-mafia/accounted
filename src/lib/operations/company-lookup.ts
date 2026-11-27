/**
 * A company in the public register by organisationsnummer, through the v1
 * door: the facts gnubok_lookup_company answers over MCP (name, address,
 * F-skatt, VAT, legal form, fiscal year, registration date, SNI codes).
 *
 * The register is asked of the extension that provides it (the TIC
 * extension, through lib/company-lookup/registry-lookup.ts): core never
 * imports extension code, so without the extension the answer is
 * `unavailable`, reason not_configured. The call is charged to the share the
 * MCP lookup spends (mcp_lookup in lib/tic-budget) with its daily cap per
 * subject, here the key's user, so a key reaches no further over REST than
 * over MCP. MCP keeps its hand-written tool: it works before any company
 * exists and adds the onboarding guidance (the create_company prefill, the
 * questions still to ask) on top of the same register answer.
 *
 * A read sent as POST: a sole trader's organisationsnummer is the owner's
 * personnummer, and a URL is copied into request logs and error telemetry
 * (as for POST /api/extensions/ext/tic/lookup).
 */
import { z } from 'zod'
import { lookupCompanyInRegistry } from '@/lib/company-lookup/registry-lookup'
import { REGISTRY_UNAVAILABLE_REASONS, type CompanyLookupResult } from '@/lib/company-lookup/types'
import { isValidOrgNumber, normalizeOrgNumber } from '@/lib/invariants/org-number'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const RegisteredCompany = z.object({
  name: z.string().describe('The registered name (firma).'),
  org_number: z.string().describe('The organisationsnummer, 10 digits.'),
  legal_entity_type: z.string().nullable().describe('The register\'s legal form code: AB, EF, HB, KB ...'),
  is_ceased: z.boolean().describe('True when the register marks the company as ceased (avregistrerad).'),
  address: z
    .object({ street: z.string().nullable(), postal_code: z.string().nullable(), city: z.string().nullable() })
    .nullable()
    .describe('The most recently registered address.'),
  f_skatt: z.boolean().describe('Registered for F-skatt.'),
  vat_registered: z.boolean().describe('Registered for VAT (moms). False also when the register says nothing.'),
  fiscal_year: z
    .object({ start_month_day: z.string().nullable(), end_month_day: z.string().nullable() })
    .nullable()
    .describe('The räkenskapsår of the latest closed period, as MM-DD; null before the first one closes.'),
  registration_date: z.string().nullable().describe('YYYY-MM-DD the company was registered.'),
  sni_codes: z.array(z.object({ code: z.string(), name: z.string() })).describe('Industry codes (SNI 2007), in the register\'s order.'),
})

type RegisteredCompanyOut = z.infer<typeof RegisteredCompany>

/** The register's answer in the v1 door's shape. */
function registeredCompany(orgNumber: string, result: CompanyLookupResult): RegisteredCompanyOut {
  return {
    name: result.companyName,
    org_number: orgNumber,
    legal_entity_type: result.legalEntityType ?? null,
    is_ceased: result.isCeased,
    address: result.address
      ? { street: result.address.street, postal_code: result.address.postalCode, city: result.address.city }
      : null,
    f_skatt: result.registration.fTax,
    vat_registered: result.registration.vat,
    fiscal_year: result.fiscalYear
      ? { start_month_day: result.fiscalYear.startMonthDay, end_month_day: result.fiscalYear.endMonthDay }
      : null,
    registration_date: result.registrationDate ? new Date(result.registrationDate).toISOString().slice(0, 10) : null,
    sni_codes: result.sniCodes,
  }
}

export const companyLookupGet = defineOperation({
  id: 'company-lookup.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Look up a Swedish company in the public register by organisationsnummer.',
    description:
      'Asks the public company register for the company behind an organisationsnummer: its registered name, address, legal form, F-skatt and VAT registration, fiscal year, registration date and SNI codes, and whether it has ceased. status found answers the company; not_found means the register knows no such number; unavailable means the register could not be asked (reason). The same register answer gnubok_lookup_company gives over MCP. A read sent as POST, so the number (a sole trader\'s is a personnummer) stays out of URLs and logs.',
    useWhen:
      'Before creating a customer or supplier from an organisationsnummer, or to check a counterparty\'s name, address, F-skatt or VAT registration.',
    doNotUseFor:
      'The company\'s own settings (GET /settings), Bankgirot\'s name for a giro number (GET /payments/creditor-lookup), or searching the register by name.',
    pitfalls: [
      'Every lookup the register is asked spends from a shared monthly budget, with a daily cap per user: past it the answer is unavailable, reason rate_limited, until the next day. Keep the answer instead of asking again.',
      'A newly registered company can take days to appear: not_found is the register\'s answer today, not proof the number is wrong.',
      'vat_registered false also covers a register that says nothing: confirm VAT with the company before invoicing without it.',
      'A sole trader\'s number is the owner\'s personnummer, and the register answers the owner\'s name: treat the answer as personal data.',
    ],
    example: {
      request: { org_number: '556677-8899' },
      response: {
        data: {
          status: 'found',
          company: {
            name: 'Exempelbolaget AB',
            org_number: '5566778899',
            legal_entity_type: 'AB',
            is_ceased: false,
            address: { street: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' },
            f_skatt: true,
            vat_registered: true,
            fiscal_year: { start_month_day: '01-01', end_month_day: '12-31' },
            registration_date: '2018-03-01',
            sni_codes: [{ code: '62010', name: 'Dataprogrammering' }],
          },
          reason: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    org_number: z
      .string()
      .trim()
      .max(20)
      .refine(isValidOrgNumber, 'Expected an organisationsnummer: 10 digits (or 12 with 16, 18, 19 or 20 in front), hyphens and spaces allowed.')
      .describe('The organisationsnummer, e.g. 556677-8899 (a personnummer for a sole trader).'),
  }),
  output: z.object({
    status: z.enum(['found', 'not_found', 'unavailable']),
    company: RegisteredCompany.nullable().describe('The register\'s company when status is found; null otherwise.'),
    reason: z
      .enum(REGISTRY_UNAVAILABLE_REASONS)
      .nullable()
      .describe('With unavailable: not_configured (this installation has no register), rate_limited (the lookup budget or the register\'s quota is spent: try tomorrow), timeout, registry_error. Null otherwise.'),
  }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/company-lookup' },
  run: async (ctx, { org_number }) => {
    // The input's refine has accepted it, so it normalizes.
    const orgNumber = normalizeOrgNumber(org_number) as string
    let outcome: Awaited<ReturnType<typeof lookupCompanyInRegistry>>
    try {
      outcome = await lookupCompanyInRegistry(orgNumber, { purpose: 'mcp_lookup', subject: ctx.userId })
    } catch (err) {
      return { ok: false, code: 'UNKNOWN_ERROR', error: err }
    }
    if (outcome.status === 'found') {
      return { ok: true, data: { status: 'found' as const, company: registeredCompany(orgNumber, outcome.result), reason: null } }
    }
    if (outcome.status === 'not_found') return { ok: true, data: { status: 'not_found' as const, company: null, reason: null } }
    return { ok: true, data: { status: 'unavailable' as const, company: null, reason: outcome.reason } }
  },
})
