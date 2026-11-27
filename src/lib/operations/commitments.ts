/**
 * Commitments and holdings through the machine doors (Bolaget W5): the
 * company's agreements with their expected payments and dates, ställda
 * säkerheter and eventualförpliktelser, and the group structure. Reads run
 * directly; writes stage over MCP and commit on approval. The rules live in
 * lib/commitments; the dashboard's /api/commitments routes call the same
 * functions. Every door refuses COMMITMENTS_UNAVAILABLE for a company
 * outside BOLAGET_COMPANY_IDS (lib/env/commitments-switch.ts).
 */
import { z } from 'zod'
import { createAgreement, endAgreement, listAgreements, listObligations, updateAgreement } from '@/lib/commitments/agreements'
import { createSecurity, listSecurities, updateSecurity } from '@/lib/commitments/securities'
import { createGroupLink, listGroupLinks, updateGroupLink } from '@/lib/commitments/group-links'
import {
  CreateAgreementSchema,
  CreateGroupLinkSchema,
  CreateSecuritySchema,
  EndAgreementSchema,
  UpdateAgreementSchema,
  UpdateGroupLinkSchema,
  UpdateSecuritySchema,
} from '@/lib/commitments/schemas'
import { AGREEMENT_KINDS, AGREEMENT_PERIODS, GROUP_RELATIONS, SECURITY_KINDS } from '@/lib/commitments/types'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const AGREEMENT_ID = z.string().uuid().describe('The agreement (agreement_id).')
const SECURITY_ID = z.string().uuid().describe('The security or contingent liability (security_id).')
const GROUP_LINK_ID = z.string().uuid().describe('The group link (group_link_id).')

const Deadline = z.object({ due_date: z.string(), title: z.string() }).nullable()

const AgreementOut = z.object({
  agreement_id: z.string().uuid(),
  kind: z.string(),
  origin: z.enum(['derived', 'manual']).describe('derived: read from an archived document by the Arkiv pipeline (read only here); manual: registered by a person or an API client.'),
  title: z.string(),
  status: z.enum(['active', 'ended']),
  counterparty_party_id: z.string().uuid().nullable(),
  counterparty_name: z.string().nullable(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  notice_months: z.number().int().nullable(),
  renewal_terms: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string(),
  period: z.enum(AGREEMENT_PERIODS).nullable(),
  first_due_on: z.string().nullable(),
  principal: z.number().nullable(),
  interest_rate: z.number().nullable(),
  document_id: z.string().uuid().nullable(),
  source_document_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  next_payment: z
    .object({
      due_on: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.enum(['expected', 'matched', 'missed', 'waived']),
      direction: z.enum(['out', 'in']),
    })
    .nullable()
    .describe('The next expected payment, else the latest missed one: observed against the bank daily, never booked from.'),
  notice_deadline: Deadline.describe('The last day to give notice, in Viktiga datum.'),
  end_deadline: Deadline.describe('The end, expiry or maturity date, in Viktiga datum.'),
})

const EXAMPLE_AGREEMENT = {
  agreement_id: '6b2e…',
  kind: 'rental',
  origin: 'manual',
  title: 'Hyresavtal kontor Vasagatan',
  status: 'active',
  counterparty_party_id: null,
  counterparty_name: 'Fastighets AB Kvarnen',
  starts_on: '2026-01-01',
  ends_on: '2028-12-31',
  notice_months: 9,
  renewal_terms: 'Förlängs tre år i taget',
  amount: 12500,
  currency: 'SEK',
  period: 'monthly',
  first_due_on: null,
  principal: null,
  interest_rate: null,
  document_id: null,
  source_document_id: null,
  notes: null,
  next_payment: { due_on: '2026-11-01', amount: 12500, currency: 'SEK', status: 'expected', direction: 'out' },
  notice_deadline: { due_date: '2028-03-31', title: 'Sista dag att säga upp: Hyresavtal kontor Vasagatan' },
  end_deadline: { due_date: '2028-12-31', title: 'Hyresavtal kontor Vasagatan löper ut, förlängs annars' },
}

const ObligationOut = z.object({
  obligation_id: z.string().uuid(),
  agreement_id: z.string().uuid(),
  agreement_title: z.string(),
  kind: z.string(),
  due_on: z.string(),
  amount: z.number(),
  currency: z.string(),
  direction: z.enum(['out', 'in']),
  status: z.enum(['expected', 'matched', 'missed', 'waived']),
  amount_is_estimate: z.boolean(),
  transaction_id: z.string().uuid().nullable().describe('The bank transaction the payment was matched to.'),
})

const SecurityOut = z.object({
  security_id: z.string().uuid(),
  kind: z.enum(SECURITY_KINDS),
  pledged: z.boolean().describe('true: a ställd säkerhet; false: an eventualförpliktelse.'),
  description: z.string(),
  amount: z.number(),
  in_favour_of_party_id: z.string().uuid().nullable(),
  in_favour_of_name: z.string().nullable(),
  for_group_company: z.boolean(),
  agreement_id: z.string().uuid().nullable(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  document_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
})

const EXAMPLE_SECURITY = {
  security_id: '91c0…',
  kind: 'foretagsinteckning',
  pledged: true,
  description: 'Företagsinteckning för checkkredit',
  amount: 500000,
  in_favour_of_party_id: null,
  in_favour_of_name: 'Handelsbanken',
  for_group_company: false,
  agreement_id: null,
  valid_from: '2025-03-01',
  valid_to: null,
  document_id: null,
  notes: null,
}

const GroupLinkOut = z.object({
  group_link_id: z.string().uuid(),
  relation: z.enum(GROUP_RELATIONS),
  counterparty_name: z.string(),
  counterparty_org_number: z.string().nullable(),
  counterparty_registered_office: z.string().nullable(),
  party_id: z.string().uuid().nullable(),
  ownership_percent: z.number().nullable(),
  voting_percent: z.number().nullable(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  bas_account: z.string().nullable(),
  linked_company_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
})

const EXAMPLE_GROUP_LINK = {
  group_link_id: '3a77…',
  relation: 'parent',
  counterparty_name: 'Ägarbolaget AB',
  counterparty_org_number: '559000-0000',
  counterparty_registered_office: 'Stockholm',
  party_id: null,
  ownership_percent: 100,
  voting_percent: 100,
  valid_from: '2024-01-01',
  valid_to: null,
  bas_account: null,
  linked_company_id: null,
  notes: null,
}

const UNAVAILABLE_PITFALL =
  'COMMITMENTS_UNAVAILABLE: Avtal och åtaganden is switched on company by company and is not on for this company (GET /capabilities says so under the year-end module); support switches it on, and a self-hosted instance lists the company in BOLAGET_COMPANY_IDS.'

// ── Agreements ────────────────────────────────────────────────────

export const agreementsList = defineOperation({
  id: 'agreements.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s agreements (rent, leases, loans, subscriptions, insurance, permits, IP, domains, guarantees and more) with the next payment and the notice and end dates.',
    description:
      'Both the agreements registered by hand (origin manual) and the ones the archive read from documents (origin derived). next_payment is observed against the bank daily and never booked from; notice_deadline and end_deadline are the dates in Viktiga datum.',
    useWhen: 'You need to know what the company has signed: what it pays and when, and when something must be terminated or renewed.',
    doNotUseFor: 'Booking payments (the agreements never post) or reading the agreement text (read the linked document).',
    pitfalls: [UNAVAILABLE_PITFALL],
    example: { response: { data: { agreements: [EXAMPLE_AGREEMENT] }, meta: META } },
  },
  input: z.object({
    status: z.enum(['active', 'ended']).optional().describe('Only active or ended agreements.'),
    kind: z.enum(AGREEMENT_KINDS).optional().describe('Only this kind.'),
    origin: z.enum(['derived', 'manual']).optional().describe('Only derived or manual agreements.'),
  }),
  output: z.object({ agreements: z.array(AgreementOut) }),
  errorCodes: ['COMMITMENTS_UNAVAILABLE'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/agreements' },
  mcp: {
    name: 'gnubok_list_agreements',
    title: 'List Agreements',
    description: 'List agreements (rent, leases, loans, subscriptions, insurance, permits, IP rights, domains, guarantees) with the next expected payment and the notice and end dates.',
    visibility: 'search',
    keywords: ['avtal', 'hyresavtal', 'leasingavtal', 'låneavtal', 'abonnemang', 'försäkring', 'tillstånd', 'domän', 'uppsägningstid', 'åtaganden'],
  },
  run: (ctx, input) => listAgreements(ctx, input),
})

export const agreementsListObligations = defineOperation({
  id: 'agreements.list-obligations',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the payments the agreements say fall due, oldest first, with whether each arrived in the bank.',
    description:
      'From 60 days back by default (from, to narrow it). status expected: not seen yet; matched: a bank transaction (transaction_id) has the amount and date; missed: nothing arrived two weeks after the due date. Observation only: nothing is booked from these rows.',
    useWhen: 'You need the upcoming payments of the company\'s agreements, or to see which rent or instalment was missed.',
    doNotUseFor: 'Supplier invoices or bank payments (they have their own lists).',
    pitfalls: [UNAVAILABLE_PITFALL, 'AGREEMENT_NOT_FOUND: agreement_id is not an agreement of the company.'],
    example: {
      response: {
        data: {
          obligations: [
            {
              obligation_id: 'c1d2…',
              agreement_id: '6b2e…',
              agreement_title: 'Hyresavtal kontor Vasagatan',
              kind: 'payment',
              due_on: '2026-11-01',
              amount: 12500,
              currency: 'SEK',
              direction: 'out',
              status: 'expected',
              amount_is_estimate: false,
              transaction_id: null,
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    agreement_id: z.string().uuid().optional().describe('Only this agreement\'s payments.'),
    status: z.enum(['expected', 'matched', 'missed', 'waived']).optional(),
    from: saneIsoDateSchema.optional().describe('yyyy-MM-dd, default 60 days back.'),
    to: saneIsoDateSchema.optional().describe('yyyy-MM-dd, inclusive.'),
  }),
  output: z.object({ obligations: z.array(ObligationOut) }),
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'AGREEMENT_NOT_FOUND'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/agreement-obligations' },
  mcp: {
    name: 'gnubok_list_agreement_obligations',
    title: 'List Agreement Obligations',
    description: 'List the payments the company\'s agreements say fall due (rent, premiums, instalments) and whether each arrived in the bank: expected, matched or missed.',
    visibility: 'search',
    keywords: ['förväntade betalningar', 'hyra betald', 'missad betalning', 'avtalsbetalningar', 'kommande betalningar'],
  },
  run: (ctx, input) => listObligations(ctx, input),
})

const agreementStageTitle = (prefix: string) => (input: Record<string, unknown>, preview?: Record<string, unknown>) => {
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : typeof preview?.title === 'string' ? preview.title : 'avtal'
  return `${prefix}: ${title}`
}

export const agreementsCreate = defineOperation({
  id: 'agreements.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Register an agreement by hand: what it is, the counterparty, the dates, notice and what it costs.',
    description:
      'With amount and period, the expected payments a year ahead are written and compared with the bank daily. With ends_on, the end (or a loan\'s maturity) goes to Viktiga datum, and with notice_months also the last day to give notice. A document is linked by document_id, never read into fields. Dry-runnable.',
    useWhen: 'The company has an agreement the books should remember: rent, a lease, a loan, a subscription, an insurance, a permit, an IP right, a domain, a guarantee.',
    doNotUseFor: 'Booking anything (agreements never post) or changing an agreement the archive read from a document (origin derived).',
    pitfalls: [
      UNAVAILABLE_PITFALL,
      'VALIDATION_ERROR: an amount needs a period, and ends_on cannot be before starts_on.',
      'COMMITMENTS_REFERENCE_NOT_FOUND: counterparty_party_id or document_id is not the company\'s (details.field).',
    ],
    example: {
      request: { kind: 'rental', title: 'Hyresavtal kontor Vasagatan', counterparty_name: 'Fastighets AB Kvarnen', starts_on: '2026-01-01', ends_on: '2028-12-31', notice_months: 9, amount: 12500, period: 'monthly' },
      response: { data: EXAMPLE_AGREEMENT, meta: META },
    },
  },
  input: CreateAgreementSchema,
  output: AgreementOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'COMMITMENTS_REFERENCE_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/agreements' },
  mcp: {
    name: 'gnubok_create_agreement',
    title: 'Create Agreement',
    description: 'Stage registering an agreement (rent, lease, loan, subscription, insurance, permit, IP right, domain, guarantee): dates, notice, amount and period give expected payments and Viktiga datum. Nothing is booked.',
    visibility: 'search',
    keywords: ['registrera avtal', 'nytt avtal', 'hyresavtal', 'leasingavtal', 'försäkring', 'tillstånd', 'domän', 'uppsägningstid'],
    stage: { pendingType: 'create_agreement', title: agreementStageTitle('Registrera avtal') },
  },
  run: (ctx, input, { dryRun }) => createAgreement(ctx, input, { dryRun }),
})

export const agreementsUpdate = defineOperation({
  id: 'agreements.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Change a manual agreement; its expected payments and its dates follow.',
    description: 'Send only the fields that change; null clears one. Payments already matched or missed stay. Dry-runnable.',
    useWhen: 'The rent changed, the agreement was extended, the notice period was wrong.',
    doNotUseFor: 'Ending an agreement (POST /agreements/{id}/end) or an agreement the archive read from a document.',
    pitfalls: [
      UNAVAILABLE_PITFALL,
      'AGREEMENT_DERIVED: the agreement was read from an archived document; correct the reading there.',
      'AGREEMENT_NOT_FOUND',
    ],
    example: { request: { amount: 13000 }, response: { data: { ...EXAMPLE_AGREEMENT, amount: 13000 }, meta: META } },
  },
  input: UpdateAgreementSchema.safeExtend({ agreement_id: AGREEMENT_ID }),
  output: AgreementOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'AGREEMENT_NOT_FOUND', 'AGREEMENT_DERIVED', 'COMMITMENTS_REFERENCE_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/agreements/:id', pathParams: { id: 'agreement_id' } },
  mcp: {
    name: 'gnubok_update_agreement',
    title: 'Update Agreement',
    description: 'Stage a change to a manually registered agreement (amount, period, dates, notice, counterparty, document link); its expected payments and Viktiga datum follow.',
    visibility: 'search',
    keywords: ['ändra avtal', 'ny hyra', 'förlängt avtal', 'uppdatera avtal'],
    stage: { pendingType: 'update_agreement', title: agreementStageTitle('Ändra avtal') },
  },
  run: (ctx, input, { dryRun }) => {
    const { agreement_id, ...changes } = input
    return updateAgreement(ctx, agreement_id, changes, { dryRun })
  },
})

export const agreementsEnd = defineOperation({
  id: 'agreements.end',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'End a manual agreement: no more expected payments after the day it ended, its dates leave Viktiga datum.',
    description: 'ended_on defaults to today; an earlier ends_on stays. Ending twice answers the same. Dry-runnable.',
    useWhen: 'The agreement was terminated, expired or replaced.',
    doNotUseFor: 'Removing an agreement that never existed (end it with the day it started) or an agreement the archive read from a document.',
    pitfalls: [UNAVAILABLE_PITFALL, 'AGREEMENT_DERIVED', 'AGREEMENT_NOT_FOUND'],
    example: { request: { ended_on: '2026-10-31' }, response: { data: { ...EXAMPLE_AGREEMENT, status: 'ended', ends_on: '2026-10-31' }, meta: META } },
  },
  input: EndAgreementSchema.safeExtend({ agreement_id: AGREEMENT_ID }),
  output: AgreementOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'AGREEMENT_NOT_FOUND', 'AGREEMENT_DERIVED', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/agreements/:id/end', pathParams: { id: 'agreement_id' } },
  mcp: {
    name: 'gnubok_end_agreement',
    title: 'End Agreement',
    description: 'Stage ending a manually registered agreement: no expected payments after the day it ended, and its notice and end dates leave Viktiga datum.',
    visibility: 'search',
    keywords: ['avsluta avtal', 'uppsagt avtal', 'avtal upphört'],
    stage: { pendingType: 'end_agreement', title: agreementStageTitle('Avsluta avtal') },
  },
  run: (ctx, input, { dryRun }) => {
    const { agreement_id, ...rest } = input
    return endAgreement(ctx, agreement_id, rest, { dryRun })
  },
})

// ── Ställda säkerheter and eventualförpliktelser ───────────────────

const NoteTextsOut = z.object({
  securities_pledged: z.string().nullable().describe('The ställda säkerheter note text the register writes (null: "Inga.").'),
  contingent_liabilities: z.string().nullable().describe('The eventualförpliktelser note text the register writes (null: "Inga.").'),
})

export const securitiesList = defineOperation({
  id: 'securities.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List ställda säkerheter and eventualförpliktelser, with the årsredovisning note texts they give on a balance date.',
    description:
      'Rows are dated (valid_from, valid_to); the note texts count the rows that hold on balance_date (default today), per K2 type, with borgen always stated and what was given for group companies apart. A manual text on the årsredovisning overrides them.',
    useWhen: 'You prepare the årsredovisning notes, or need to know what the company has pledged or guaranteed.',
    doNotUseFor: 'Loans themselves (agreements of kind loan).',
    pitfalls: [UNAVAILABLE_PITFALL],
    example: {
      response: {
        data: {
          securities: [EXAMPLE_SECURITY],
          balance_date: '2026-12-31',
          note_texts: { securities_pledged: 'Företagsinteckningar 500 000 kr.', contingent_liabilities: null },
        },
        meta: META,
      },
    },
  },
  input: z.object({ balance_date: saneIsoDateSchema.optional().describe('yyyy-MM-dd the note texts are stated per; default today.') }),
  output: z.object({ securities: z.array(SecurityOut), balance_date: z.string(), note_texts: NoteTextsOut }),
  errorCodes: ['COMMITMENTS_UNAVAILABLE'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/securities' },
  mcp: {
    name: 'gnubok_list_securities',
    title: 'List Securities And Contingencies',
    description: 'List ställda säkerheter (företagsinteckning, fastighetsinteckning, äganderättsförbehåll, belånad fordran) and eventualförpliktelser (borgen), with the årsredovisning note texts.',
    visibility: 'search',
    keywords: ['ställda säkerheter', 'eventualförpliktelser', 'företagsinteckning', 'borgen', 'pant', 'fastighetsinteckning', 'not årsredovisning'],
  },
  run: (ctx, input) => listSecurities(ctx, input),
})

const securityStageTitle = (prefix: string) => (input: Record<string, unknown>) => {
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : 'säkerhet'
  return `${prefix}: ${description}`
}

export const securitiesCreate = defineOperation({
  id: 'securities.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Register a ställd säkerhet or an eventualförpliktelse.',
    description:
      'amount is the mortgage amount (pantbrev, företagsinteckning), the book value of the pledged asset or the guaranteed amount, in SEK. for_group_company marks what was given for a group company (stated apart). A released one gets valid_to through PATCH; rows are never deleted. Dry-runnable.',
    useWhen: 'The bank took a företagsinteckning, a property is mortgaged, an asset was bought under äganderättsförbehåll, the company signed a borgen.',
    doNotUseFor: 'The loan itself (POST /agreements, kind loan; link it with agreement_id).',
    pitfalls: [UNAVAILABLE_PITFALL, 'COMMITMENTS_REFERENCE_NOT_FOUND: in_favour_of_party_id, agreement_id or document_id is not the company\'s (details.field).'],
    example: {
      request: { kind: 'foretagsinteckning', description: 'Företagsinteckning för checkkredit', amount: 500000, in_favour_of_name: 'Handelsbanken', valid_from: '2025-03-01' },
      response: { data: EXAMPLE_SECURITY, meta: META },
    },
  },
  input: CreateSecuritySchema,
  output: SecurityOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'COMMITMENTS_REFERENCE_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/securities' },
  mcp: {
    name: 'gnubok_create_security',
    title: 'Create Security Or Contingency',
    description: 'Stage registering a ställd säkerhet (företagsinteckning, fastighetsinteckning, äganderättsförbehåll, belånad fordran) or an eventualförpliktelse (borgen) for the årsredovisning notes.',
    visibility: 'search',
    keywords: ['registrera säkerhet', 'företagsinteckning', 'borgen', 'pantbrev', 'äganderättsförbehåll', 'eventualförpliktelse'],
    stage: { pendingType: 'create_security', title: securityStageTitle('Registrera säkerhet') },
  },
  run: (ctx, input, { dryRun }) => createSecurity(ctx, input, { dryRun }),
})

export const securitiesUpdate = defineOperation({
  id: 'securities.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Change a ställd säkerhet or an eventualförpliktelse, or release it with valid_to.',
    description: 'Send only the fields that change; null clears one. Dry-runnable.',
    useWhen: 'A mortgage was raised, a borgen released, the book value of a pledged asset changed.',
    doNotUseFor: 'Removing history: a released security keeps its row with valid_to.',
    pitfalls: [UNAVAILABLE_PITFALL, 'SECURITY_NOT_FOUND'],
    example: { request: { valid_to: '2026-06-30' }, response: { data: { ...EXAMPLE_SECURITY, valid_to: '2026-06-30' }, meta: META } },
  },
  input: UpdateSecuritySchema.safeExtend({ security_id: SECURITY_ID }),
  output: SecurityOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'SECURITY_NOT_FOUND', 'COMMITMENTS_REFERENCE_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/securities/:id', pathParams: { id: 'security_id' } },
  mcp: {
    name: 'gnubok_update_security',
    title: 'Update Security Or Contingency',
    description: 'Stage a change to a ställd säkerhet or eventualförpliktelse (amount, dates, who it is for), or release it with valid_to.',
    visibility: 'search',
    keywords: ['ändra säkerhet', 'släppt borgen', 'utlöst pant'],
    stage: { pendingType: 'update_security', title: securityStageTitle('Ändra säkerhet') },
  },
  run: (ctx, input, { dryRun }) => {
    const { security_id, ...changes } = input
    return updateSecurity(ctx, security_id, changes, { dryRun })
  },
})

// ── Group structure ────────────────────────────────────────────────

export const groupLinksList = defineOperation({
  id: 'group-links.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s group structure: its parent, subsidiaries and associates with ownership and votes over time.',
    description:
      'applies is false for a legal form that prepares no årsredovisning (an enskild firma). The parent link that holds on the balance date prefills the koncernförhållanden note.',
    useWhen: 'You need the parent company for the årsredovisning, or which companies the company owns.',
    doNotUseFor: 'Consolidated accounts (koncernredovisning is not prepared here).',
    pitfalls: [UNAVAILABLE_PITFALL],
    example: { response: { data: { group_links: [EXAMPLE_GROUP_LINK], applies: true }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ group_links: z.array(GroupLinkOut), applies: z.boolean() }),
  errorCodes: ['COMMITMENTS_UNAVAILABLE'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/group-links' },
  mcp: {
    name: 'gnubok_list_group_links',
    title: 'List Group Links',
    description: 'List the group structure: parent company, subsidiaries (dotterföretag) and associates (intresseföretag) with ownership and voting percent and dates.',
    visibility: 'search',
    keywords: ['koncern', 'moderbolag', 'dotterbolag', 'intresseföretag', 'ägarandel', 'koncernförhållanden'],
  },
  run: (ctx) => listGroupLinks(ctx),
})

const groupLinkStageTitle = (prefix: string) => (input: Record<string, unknown>) => {
  const name = typeof input.counterparty_name === 'string' && input.counterparty_name.trim() ? input.counterparty_name.trim() : 'koncernföretag'
  return `${prefix}: ${name}`
}

export const groupLinksCreate = defineOperation({
  id: 'group-links.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Register a parent, subsidiary or associate of the company.',
    description:
      'counterparty_registered_office (säte) and counterparty_org_number go into the koncernförhållanden note for a parent. linked_company_id names the same company in Accounted when it is in the caller\'s team. Dry-runnable.',
    useWhen: 'The company is owned by another company, or owns shares in one.',
    doNotUseFor: 'Individual shareholders (the aktiebok) or an enskild firma (no group structure).',
    pitfalls: [
      UNAVAILABLE_PITFALL,
      'GROUP_LINKS_NOT_FOR_LEGAL_FORM: only companies that prepare an årsredovisning have a group structure here.',
      'GROUP_LINK_COMPANY_NOT_IN_TEAM: linked_company_id must be another company in the same team.',
    ],
    example: {
      request: { relation: 'parent', counterparty_name: 'Ägarbolaget AB', counterparty_org_number: '559000-0000', counterparty_registered_office: 'Stockholm', ownership_percent: 100, voting_percent: 100, valid_from: '2024-01-01' },
      response: { data: EXAMPLE_GROUP_LINK, meta: META },
    },
  },
  input: CreateGroupLinkSchema,
  output: GroupLinkOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'GROUP_LINKS_NOT_FOR_LEGAL_FORM', 'GROUP_LINK_COMPANY_NOT_IN_TEAM', 'COMMITMENTS_REFERENCE_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/group-links' },
  mcp: {
    name: 'gnubok_create_group_link',
    title: 'Create Group Link',
    description: 'Stage registering a parent company, subsidiary or associate with ownership and voting percent; an active parent prefills the koncernförhållanden note.',
    visibility: 'search',
    keywords: ['moderbolag', 'dotterbolag', 'koncern', 'intresseföretag', 'registrera koncern'],
    stage: { pendingType: 'create_group_link', title: groupLinkStageTitle('Registrera koncernföretag') },
  },
  run: (ctx, input, { dryRun }) => createGroupLink(ctx, input, { dryRun }),
})

export const groupLinksUpdate = defineOperation({
  id: 'group-links.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Change a group link, or end it with valid_to.',
    description: 'Send only the fields that change; null clears one. Dry-runnable.',
    useWhen: 'Ownership changed, the parent sold the company, a subsidiary was wound up.',
    doNotUseFor: 'Removing history: an ended relation keeps its row with valid_to.',
    pitfalls: [UNAVAILABLE_PITFALL, 'GROUP_LINK_NOT_FOUND', 'GROUP_LINKS_NOT_FOR_LEGAL_FORM'],
    example: { request: { ownership_percent: 60 }, response: { data: { ...EXAMPLE_GROUP_LINK, ownership_percent: 60 }, meta: META } },
  },
  input: UpdateGroupLinkSchema.safeExtend({ group_link_id: GROUP_LINK_ID }),
  output: GroupLinkOut,
  errorCodes: ['COMMITMENTS_UNAVAILABLE', 'GROUP_LINK_NOT_FOUND', 'GROUP_LINKS_NOT_FOR_LEGAL_FORM', 'GROUP_LINK_COMPANY_NOT_IN_TEAM', 'COMMITMENTS_REFERENCE_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/group-links/:id', pathParams: { id: 'group_link_id' } },
  mcp: {
    name: 'gnubok_update_group_link',
    title: 'Update Group Link',
    description: 'Stage a change to a parent, subsidiary or associate link (ownership, votes, dates, säte), or end it with valid_to.',
    visibility: 'search',
    keywords: ['ändra koncern', 'såld dotterbolag', 'ändrad ägarandel'],
    stage: { pendingType: 'update_group_link', title: groupLinkStageTitle('Ändra koncernföretag') },
  },
  run: (ctx, input, { dryRun }) => {
    const { group_link_id, ...changes } = input
    return updateGroupLink(ctx, group_link_id, changes, { dryRun })
  },
})

export const COMMITMENTS_OPERATIONS = [
  agreementsList,
  agreementsListObligations,
  agreementsCreate,
  agreementsUpdate,
  agreementsEnd,
  securitiesList,
  securitiesCreate,
  securitiesUpdate,
  groupLinksList,
  groupLinksCreate,
  groupLinksUpdate,
] as const
