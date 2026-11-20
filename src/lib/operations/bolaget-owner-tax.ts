/**
 * Owner tax and related parties in Bolaget through the machine doors: the
 * K10 underlag per delägare and inkomstår (IL 57 kap. after SFS 2025:1361),
 * the owner loan register with the låneförbud check (ABL 21 kap.) and the
 * KU20 status per year. The rules live in src/lib/bolaget/owner-tax; the
 * dashboard's /api/bolaget/owner-tax routes call the same functions.
 *
 * Reads answer names and masked identities only. The KU20 file (it carries
 * full personnummer) and the PDFs have no machine door: they are
 * downloaded in Accounted. Every write stages over MCP; none of them books.
 *
 * Every door is dark outside BOLAGET_COMPANY_IDS and for a legal form that
 * keeps no aktiebok (BOLAGET_DISABLED, BOLAGET_NOT_FOR_LEGAL_FORM).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { bolagetGate } from '@/lib/bolaget/gate'
import { loadK10Year, saveK10Inputs, type K10YearView } from '@/lib/bolaget/owner-tax/k10'
import { K10_LINE_KEYS } from '@/lib/bolaget/owner-tax/k10-math'
import { loadKu20Status } from '@/lib/bolaget/owner-tax/ku20'
import { createOwnerLoan, setLoanInterest, updateOwnerLoan } from '@/lib/bolaget/owner-tax/loans'
import { loadOwnerLoansView } from '@/lib/bolaget/owner-tax/loans-view'
import { K10InputsBody, LoanInterestBody, OwnerLoanCreateBody, OwnerLoanUpdateBody } from '@/lib/bolaget/owner-tax/schemas'
import { DEFAULT_LOAN_ACCOUNTS, LOAN_DIRECTIONS, LOAN_EXCEPTIONS, LOAN_KINDS, LOAN_RELATIONS, LOAN_STATUSES } from '@/lib/bolaget/owner-tax/types'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

async function gated<T>(ctx: OperationContext, run: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>> {
  const code = await bolagetGate(ctx.supabase, ctx.companyId)
  if (code) return { ok: false, code }
  return run()
}

const GATE_CODES = ['BOLAGET_DISABLED', 'BOLAGET_NOT_FOR_LEGAL_FORM']
const UUID = z.string().uuid()
const YEAR = z.coerce.number().int().min(2000).max(2099)
const SOURCE = z.enum(['register', 'payroll', 'ledger', 'owner', 'rule', 'computed'])
const LOAN_BAN_STATUS = z.enum(['not_applicable', 'outside_circle', 'exception', 'prohibited'])
const LOAN_BAN_EXCEPTION = z.enum(['group_company', 'business_loan', 'dispensation', 'small_holding'])
const LOAN_CIRCLE = z.enum(['holder', 'board', 'ceo', 'group_insider', 'related_person', 'controlled_entity'])
const WARNING = z.object({ code: z.string(), message_sv: z.string() })

// ── Outputs ──────────────────────────────────────────────────────────

const K10InputsOut = z.object({
  saved_dividend_space: z.number(),
  cost_basis_override: z.number().nullable(),
  payroll_base_override: z.number().nullable(),
  own_pay_override: z.number().nullable(),
  uses_basic_amount: z.boolean(),
  note: z.string().nullable(),
  updated_at: z.string().nullable(),
})

const K10ResultOut = z.object({
  lines: z.array(
    z.object({
      key: z.enum(K10_LINE_KEYS),
      label_sv: z.string(),
      amount: z.number(),
      unit: z.enum(['sek', 'percent']),
      source: SOURCE.describe('register (aktiebok), payroll, ledger (dividends), owner (entered by the owner), rule (law figure) or computed.'),
      detail_sv: z.string(),
    }),
  ),
  basic_amount: z.number(),
  wage_space: z.number(),
  capital_interest: z.number(),
  annual_limit: z.number().describe('Årets gränsbelopp.'),
  total_limit: z.number().describe('Gränsbelopp including sparat utdelningsutrymme.'),
  dividend: z.number(),
  dividend_within_limit: z.number(),
  dividend_service: z.number(),
  dividend_above_ceiling: z.number(),
  saved_space_carried_forward: z.number(),
})

const K10YearOut = z.object({
  income_year: z.number().int(),
  supported: z.boolean(),
  supported_years: z.array(z.number().int()),
  unsupported_reason_sv: z.string().nullable(),
  start_date: z.string().describe('The aktiebok day the holdings are read on: 31 December the year before.'),
  famansforetag: z.object({ value: z.boolean(), confirmed: z.boolean(), top_four_votes_pct: z.number() }),
  total_shares_at_start: z.number().int(),
  payroll: z.object({ year: z.number().int(), total: z.number(), runs: z.number().int(), opening_balance_amount: z.number(), employees: z.number().int() }),
  owners: z.array(
    z.object({
      party_id: z.string(),
      name: z.string(),
      identity: z.string().nullable().describe('Masked personnummer.'),
      shares_at_start: z.number().int(),
      dividend_received: z.number(),
      inputs: K10InputsOut,
      inputs_saved: z.boolean(),
      cost_basis: z.object({ register_amount: z.number(), contributions_amount: z.number(), amount: z.number(), complete: z.boolean(), gaps_sv: z.array(z.string()) }),
      result: K10ResultOut,
      warnings: z.array(WARNING),
    }),
  ),
  company_holders: z.array(z.object({ party_id: z.string(), name: z.string(), shares: z.number().int() })),
})

/** The K10 year as the machine doors answer it: the payroll employees behind the owner's own pay are left out. */
function k10ForDoors(view: K10YearView) {
  return {
    income_year: view.income_year,
    supported: view.supported,
    supported_years: view.supported_years,
    unsupported_reason_sv: view.unsupported_reason_sv,
    start_date: view.start_date,
    famansforetag: view.famansforetag,
    total_shares_at_start: view.total_shares_at_start,
    payroll: view.payroll,
    owners: view.owners.map((o) => ({
      party_id: o.party_id,
      name: o.name,
      identity: o.identity,
      shares_at_start: o.shares_at_start,
      dividend_received: o.dividend_received,
      inputs: o.inputs,
      inputs_saved: o.inputs_saved,
      cost_basis: { register_amount: o.cost_basis.register_amount, contributions_amount: o.cost_basis.contributions_amount, amount: o.cost_basis.amount, complete: o.cost_basis.complete, gaps_sv: o.cost_basis.gaps_sv },
      result: o.result,
      warnings: o.warnings,
    })),
    company_holders: view.company_holders,
  }
}

const LoanBanOut = z.object({
  status: LOAN_BAN_STATUS.describe('prohibited: in the ABL 21:1 circle with no exception (a warning, nothing is refused).'),
  circle: z.array(LOAN_CIRCLE),
  exception: LOAN_BAN_EXCEPTION.nullable(),
  special_list: z.boolean().describe('Goes on the ABL 21:10 special list.'),
  warnings: z.array(z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() })),
})

const OwnerLoansOut = z.object({
  as_of: z.string(),
  loans: z.array(
    z.object({
      owner_loan_id: z.string(),
      party: z.object({ party_id: z.string(), name: z.string(), kind: z.enum(['person', 'company']), identity: z.string().nullable().describe('Masked personnummer or org number.') }),
      related_to: z.object({ party_id: z.string(), name: z.string() }).nullable(),
      kind: z.enum(LOAN_KINDS),
      direction: z.enum(LOAN_DIRECTIONS),
      relation: z.enum(LOAN_RELATIONS),
      relation_detail: z.string().nullable(),
      account: z.string().nullable(),
      principal: z.number(),
      outstanding: z.number(),
      interest_rate: z.number().nullable(),
      start_date: z.string(),
      maturity_date: z.string().nullable(),
      terms: z.string().nullable(),
      document_id: z.string().nullable(),
      exception: z.enum(LOAN_EXCEPTIONS),
      exception_note: z.string().nullable(),
      status: z.enum(LOAN_STATUSES),
      repaid_on: z.string().nullable(),
      note: z.string().nullable(),
      loan_ban: LoanBanOut,
      interest: z.array(z.object({ income_year: z.number().int(), interest_amount: z.number(), tax_withheld: z.number() })),
    }),
  ),
  reconciliation: z.array(
    z.object({
      account: z.string(),
      register_amount: z.number(),
      ledger_amount: z.number().nullable(),
      difference: z.number().nullable(),
      matches: z.boolean().nullable(),
      owner_loan_ids: z.array(z.string()),
    }),
  ),
  flagged: z.number().int(),
})

const Ku20StatusOut = z.object({
  income_year: z.number().int(),
  deadline: z.string(),
  file_supported: z.boolean(),
  famansforetag: z.object({ value: z.boolean(), confirmed: z.boolean() }).describe('Whether the company is a fåmansföretag in the year: the answer confirmed for KU31, else what the aktiebok suggests.'),
  recipients: z.array(
    z.object({
      party_id: z.string(),
      name: z.string(),
      identity: z.string().nullable(),
      interest: z.number(),
      tax_withheld: z.number(),
      reported_interest: z.number().int().describe('Field 503: whole kronor.'),
      reported_tax: z.number().int().describe('Field 001: whole kronor.'),
      delagare: z.boolean().describe('Field 061.'),
      expected_tax: z.number().nullable(),
      reason: z.enum(['personnummer_missing']).nullable(),
    }),
  ),
  legal_person_interest: z.number(),
  contact: z.object({ name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }),
  blockers: z.array(z.object({ code: z.string(), message_sv: z.string(), party_id: z.string().optional() })),
  warnings: z.array(z.object({ code: z.string(), message_sv: z.string(), party_id: z.string().optional() })),
  ready: z.boolean(),
})

// ── Reads ────────────────────────────────────────────────────────────

export const k10Get = defineOperation({
  id: 'k10.get',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the K10 underlag per delägare for an inkomstår: gränsbelopp, lönebaserat utrymme, dividend and sparat utdelningsutrymme.',
    description:
      'For every natural-person holder: shares at the start of the year (aktiebok), the grundbelopp (4 IBB split per share), the lönebaserat utrymme from the payroll\'s cash pay the year before (50 % of the owner\'s share above 8 IBB, at most 50 times their own pay), interest on the omkostnadsbelopp above 100 000 kr, the dividend received, and what is carried forward. Each line names its source. The 3:12 rules after SFS 2025:1361; inkomstår 2026 onward.',
    useWhen: 'An owner asks how much dividend is taxed at 20 %, or prepares K10.',
    doNotUseFor: 'Deciding a dividend (POST /dividends) or the company\'s own tax (INK2).',
    pitfalls: [
      'The owner files K10; this is the underlag. Figures the books do not hold (sparat utdelningsutrymme, an omkostnadsbelopp from before the aktiebok) are entered with PUT /k10/{year}/owners/{party_id}.',
      'supported false: the year\'s inkomstbasbelopp or statslåneränta is not in Accounted yet, or the year is before the 2026 rules.',
    ],
    example: { response: { data: { income_year: 2026, supported: true, owners: [{ party_id: '9c1e…', name: 'Anna Ek', result: { total_limit: 750000, saved_space_carried_forward: 650000 } }] }, meta: META } },
  },
  input: z.object({ income_year: YEAR.describe('The inkomstår, e.g. 2026.') }),
  output: K10YearOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/k10/:year', pathParams: { year: 'income_year' } },
  mcp: {
    name: 'gnubok_get_k10_underlag',
    title: 'Get K10 Underlag',
    description: 'Read the K10 underlag per delägare for an inkomstår (3:12 rules from 2026): grundbelopp, lönebaserat utrymme, ränta, gränsbelopp, dividend and sparat utdelningsutrymme, each line with its source.',
    visibility: 'search',
    keywords: ['k10', '3:12', 'gränsbelopp', 'utdelningsutrymme', 'sparat utdelningsutrymme', 'lönebaserat utrymme', 'fåmansföretag', 'kvalificerade andelar'],
  },
  run: (ctx, input) => gated(ctx, async () => ({ ok: true, data: k10ForDoors(await loadK10Year(ctx, input.income_year)) })),
})

export const ownerLoansGet = defineOperation({
  id: 'owner-loans.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the owner loan register: loans and security between the company and its owners, board, VD and related persons, with the låneförbud check and the ledger reconciliation.',
    description:
      'Every loan with its counterparty (name and masked identity), direction, BAS account, principal and outstanding, terms, the ABL 21 kap. assessment (in the circle, the exception, whether it goes on the 21:10 special list) and the interest per year; and per account, the register against the ledger balance on as_of. Read-only.',
    useWhen: 'Before booking a payment to or from an owner, at year end, or when asked whether a loan to an owner is allowed.',
    doNotUseFor: 'Aktieägartillskott (GET /capital-events) or ordinary supplier debts.',
    pitfalls: ['loan_ban.status prohibited is a warning: the check cannot see every relation; the person decides.', 'A reconciliation difference means the register or the ledger needs an update; nothing is corrected automatically.'],
    example: { response: { data: { as_of: '2026-12-31', loans: [{ owner_loan_id: '2f4a…', direction: 'borrows', account: DEFAULT_LOAN_ACCOUNTS.borrows.short, outstanding: 200000 }], reconciliation: [{ account: DEFAULT_LOAN_ACCOUNTS.borrows.short, register_amount: 200000, ledger_amount: 200000, matches: true }], flagged: 0 }, meta: META } },
  },
  input: z.object({ as_of: saneIsoDateSchema.nullish().describe('The day to reconcile on (YYYY-MM-DD); today when omitted.') }),
  output: OwnerLoansOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/owner-loans' },
  mcp: {
    name: 'gnubok_get_owner_loans',
    title: 'Get Owner Loans',
    description: 'Read loans and security between the company and its owners, board, VD and related persons: låneförbud check (ABL 21 kap.), interest per year, and the register against the ledger (1360/1685/2393/2893).',
    visibility: 'search',
    keywords: ['aktieägarlån', 'lån till ägare', 'lån från ägare', 'låneförbud', 'närståendelån', 'förbjudet lån', 'skulder till närstående'],
  },
  run: (ctx, input) => gated(ctx, async () => ({ ok: true, data: await loadOwnerLoansView(ctx, input.as_of ?? null) })),
})

export const ku20StatusGet = defineOperation({
  id: 'ku20.status.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the KU20 status of an inkomstår: interest the company paid to natural persons on their loans, the tax withheld, and what blocks the file.',
    description:
      'Per recipient the year\'s interest (field 503) and tax withheld (field 001) in whole kronor, whether field 061 is marked, the 30 % a fåmansföretag withholds on interest to a delägare, and the blockers. The file itself is downloaded in Accounted by an owner or administrator: it carries personnummer.',
    useWhen: 'Before 31 January, to see whether KU20 for last year can be filed.',
    doNotUseFor: 'Getting the file: there is no machine door for it. KU31 (GET /ku31/{year}) for dividends.',
    pitfalls: ['KU20_NO_RECIPIENTS: enter the year\'s interest per loan first (POST /owner-loans/{id}/interest).'],
    example: { response: { data: { income_year: 2026, deadline: '2027-01-31', ready: false, blockers: [{ code: 'KU20_CONTACT_MISSING', message_sv: 'Ange kontaktperson…' }] }, meta: META } },
  },
  input: z.object({ income_year: YEAR.describe('The inkomstår, e.g. 2026.') }),
  output: Ku20StatusOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/ku20/:year', pathParams: { year: 'income_year' } },
  mcp: {
    name: 'gnubok_get_ku20_status',
    title: 'Get KU20 Status',
    description: 'Read KU20 for an inkomstår: interest paid to owners and related persons on their loans (field 503), tax withheld (001), masked identity and what blocks the file. The file is downloaded in Accounted only.',
    visibility: 'search',
    keywords: ['ku20', 'kontrolluppgift ränta', 'ränta aktieägarlån', 'ränteinkomst', 'kontrolluppgifter'],
  },
  run: (ctx, input) => gated(ctx, async () => ({ ok: true, data: await loadKu20Status(ctx, input.income_year) })),
})

// ── Writes ───────────────────────────────────────────────────────────

export const k10InputsSet = defineOperation({
  id: 'k10-inputs.set',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Save what a delägare enters for the K10 underlag of a year: sparat utdelningsutrymme, an omkostnadsbelopp, a löneunderlag or own pay that differs from the payroll.',
    description:
      'Upserts the owner\'s figures for the inkomstår (omitted fields keep their value; null clears an override) and answers the recomputed underlag. Nothing is booked or filed. Dry-runnable.',
    useWhen: 'The owner gives last year\'s sparat utdelningsutrymme, or the K10 shows a warning that a figure is missing.',
    doNotUseFor: 'Changing the aktiebok or the payroll: correct them where they are kept.',
    pitfalls: ['K10_OWNER_NOT_FOUND: the party held no shares at the start of the year and received no dividend in it.'],
    example: {
      request: { party_id: '9c1e…', income_year: 2026, saved_dividend_space: 120000 },
      response: { data: { party_id: '9c1e…', income_year: 2026, inputs: { saved_dividend_space: 120000 }, result: { total_limit: 870000 } }, meta: META },
    },
  },
  input: K10InputsBody.extend({ party_id: UUID, income_year: YEAR }).strict(),
  output: z.object({ party_id: z.string(), income_year: z.number().int(), inputs: K10InputsOut, result: K10ResultOut.nullable() }),
  errorCodes: [...GATE_CODES, 'K10_YEAR_UNSUPPORTED', 'K10_OWNER_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'PUT', path: '/api/v1/companies/:companyId/k10/:year/owners/:partyId', pathParams: { year: 'income_year', partyId: 'party_id' } },
  mcp: {
    name: 'gnubok_set_k10_owner_inputs',
    title: 'Set K10 Owner Inputs',
    description: 'Stage an owner\'s K10 figures for an inkomstår that the books do not hold: sparat utdelningsutrymme, omkostnadsbelopp, a löneunderlag or own pay override, grundbelopp used here.',
    visibility: 'search',
    keywords: ['k10', 'sparat utdelningsutrymme', 'omkostnadsbelopp', 'löneunderlag', 'gränsbelopp'],
    stage: { pendingType: 'set_k10_owner_inputs', title: (input) => `K10-underlag ${typeof input.income_year === 'number' ? input.income_year : ''}`.trim() },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => saveK10Inputs(ctx, input, { dryRun })),
})

const LoanBanBrief = z.object({ status: LOAN_BAN_STATUS, exception: LOAN_BAN_EXCEPTION.nullable(), special_list: z.boolean() })

export const ownerLoansCreate = defineOperation({
  id: 'owner-loans.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Register a loan between the company and an owner, board member, VD or related person, or security the company gave for one; checked against the låneförbud (ABL 21 kap.).',
    description:
      'Records the counterparty, direction, BAS account (1685 or 2893 when omitted), principal, interest, terms and the exception claimed. A loan from the company to someone in the ABL 21:1 circle without an exception is warned about (LOAN_BAN_PROHIBITED), never refused. Nothing is booked: the payout is booked as any verifikat. Dry-runnable.',
    useWhen: 'An owner lends money to the company, or the company lends to or guarantees for an insider.',
    doNotUseFor: 'Aktieägartillskott (POST /shareholder-contributions) or dividends.',
    pitfalls: ['OWNER_LOAN_ACCOUNT_INVALID: a loan the company gives sits on 1360-1368 or 1680-1689, one it takes on 2390-2399 or 2890-2899.', 'A personnummer is never sent: name a new person, and the personnummer is added in Accounted.'],
    example: {
      request: { party_id: '9c1e…', direction: 'borrows', principal: 200000, interest_rate: 5, start_date: '2026-03-01' },
      response: { data: { owner_loan_id: '2f4a…', party_id: '9c1e…', kind: 'loan', direction: 'borrows', account: DEFAULT_LOAN_ACCOUNTS.borrows.short, principal: 200000, outstanding: 200000, loan_ban: { status: 'not_applicable', exception: null, special_list: false } }, meta: META },
    },
  },
  input: OwnerLoanCreateBody,
  output: z.object({
    owner_loan_id: z.string(),
    party_id: z.string(),
    kind: z.enum(LOAN_KINDS),
    direction: z.enum(LOAN_DIRECTIONS),
    account: z.string().nullable(),
    principal: z.number(),
    outstanding: z.number(),
    loan_ban: LoanBanBrief,
  }),
  errorCodes: [...GATE_CODES, 'OWNER_LOAN_ACCOUNT_INVALID', 'OWNER_LOAN_RELATED_REQUIRED', 'OWNER_LOAN_OUTSTANDING_INVALID', 'BOLAGET_DATES_INVALID', 'BOLAGET_PARTY_NOT_FOUND', 'BOLAGET_PARTY_INVALID', 'BOLAGET_PERSONNUMMER_IN_APP_ONLY', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/owner-loans' },
  mcp: {
    name: 'gnubok_create_owner_loan',
    title: 'Create Owner Loan',
    description: 'Stage a loan between the company and an owner, board member, VD or related person (or security for one) in the owner loan register; checked against the låneförbud (ABL 21 kap.). Books nothing.',
    visibility: 'search',
    keywords: ['aktieägarlån', 'lån från ägare', 'lån till ägare', 'låneförbud', 'närståendelån', 'borgen för ägare'],
    stage: {
      pendingType: 'create_owner_loan',
      title: (input) => (input.direction === 'borrows' ? 'Lån från ägare eller närstående' : input.kind === 'security' ? 'Säkerhet för ägare eller närstående' : 'Lån till ägare eller närstående'),
    },
  },
  run: (ctx, input, { dryRun }) =>
    gated(ctx, () =>
      createOwnerLoan(
        ctx,
        {
          ...input,
          party: { party_id: input.party_id ?? null, name: input.party_name ?? null, kind: input.party_kind ?? null, org_number: input.party_org_number ?? null },
        },
        { dryRun },
      ),
    ),
})

export const ownerLoansUpdate = defineOperation({
  id: 'owner-loans.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Update an owner loan: outstanding after a repayment, terms, the exception claimed, or mark it repaid or cancelled.',
    description:
      'Changes only what is sent (null clears a field). Status repaid needs repaid_on and sets outstanding to 0; cancelled is for a loan registered by mistake and is final. The låneförbud check runs again and warns. Nothing is booked. Dry-runnable.',
    useWhen: 'An owner loan was partly or fully repaid, or its terms changed.',
    doNotUseFor: 'The year\'s interest (POST /owner-loans/{id}/interest).',
    pitfalls: ['OWNER_LOAN_STATUS_INVALID: a cancelled loan does not change.'],
    example: { request: { owner_loan_id: '2f4a…', status: 'repaid', repaid_on: '2026-11-30' }, response: { data: { owner_loan_id: '2f4a…', status: 'repaid', outstanding: 0, loan_ban: { status: 'not_applicable', exception: null, special_list: false } }, meta: META } },
  },
  input: OwnerLoanUpdateBody.extend({ owner_loan_id: UUID }).strict(),
  output: z.object({ owner_loan_id: z.string(), status: z.enum(LOAN_STATUSES), outstanding: z.number(), loan_ban: LoanBanBrief }),
  errorCodes: [...GATE_CODES, 'OWNER_LOAN_NOT_FOUND', 'OWNER_LOAN_STATUS_INVALID', 'OWNER_LOAN_ACCOUNT_INVALID', 'OWNER_LOAN_RELATED_REQUIRED', 'OWNER_LOAN_OUTSTANDING_INVALID', 'BOLAGET_DATES_INVALID', 'VALIDATION_ERROR'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/owner-loans/:id', pathParams: { id: 'owner_loan_id' } },
  mcp: {
    name: 'gnubok_update_owner_loan',
    title: 'Update Owner Loan',
    description: 'Stage a change to an owner loan: outstanding after a repayment, terms, exception claimed, or repaid or cancelled. Checked again against the låneförbud. Books nothing.',
    visibility: 'search',
    keywords: ['återbetalt lån', 'aktieägarlån', 'lån ägare ändra', 'låneförbud'],
    stage: { pendingType: 'update_owner_loan', title: (input) => (input.status === 'repaid' ? 'Ägarlån återbetalt' : input.status === 'cancelled' ? 'Ägarlån makulerat' : 'Ändrat ägarlån') },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => updateOwnerLoan(ctx, input, { dryRun })),
})

export const ownerLoansSetInterest = defineOperation({
  id: 'owner-loans.set-interest',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Record the interest on an owner loan for an inkomstår and the tax withheld: the figures KU20 reports.',
    description:
      'Upserts the year\'s interest paid (company borrows) or received (company lends) and the preliminary tax withheld. Warns when a fåmansföretag did not withhold 30 % on interest to a delägare (SFL 10:15). Nothing is booked. Dry-runnable.',
    useWhen: 'At year end, before KU20, or when the interest was paid.',
    doNotUseFor: 'Booking the interest (a verifikat on 8400-8499 or 8300-8399).',
    pitfalls: ['The tax withheld cannot exceed the interest.'],
    example: { request: { owner_loan_id: '2f4a…', income_year: 2026, interest_amount: 8000, tax_withheld: 2400 }, response: { data: { owner_loan_id: '2f4a…', income_year: 2026, interest_amount: 8000, tax_withheld: 2400 }, meta: META } },
  },
  input: LoanInterestBody.extend({ owner_loan_id: UUID }).strict(),
  output: z.object({ owner_loan_id: z.string(), income_year: z.number().int(), interest_amount: z.number(), tax_withheld: z.number() }),
  errorCodes: [...GATE_CODES, 'OWNER_LOAN_NOT_FOUND', 'OWNER_LOAN_STATUS_INVALID', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/owner-loans/:id/interest', pathParams: { id: 'owner_loan_id' } },
  mcp: {
    name: 'gnubok_set_owner_loan_interest',
    title: 'Set Owner Loan Interest',
    description: 'Stage the interest on an owner loan for an inkomstår and the tax withheld (KU20 fields 503 and 001). Warns when a fåmansföretag withheld less than 30 %. Books nothing.',
    visibility: 'search',
    keywords: ['ränta aktieägarlån', 'ku20', 'ränta ägare', 'skatteavdrag ränta', 'ränteinkomst'],
    stage: { pendingType: 'set_owner_loan_interest', title: (input) => `Ränta på ägarlån ${typeof input.income_year === 'number' ? input.income_year : ''}`.trim() },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => setLoanInterest(ctx, input, { dryRun })),
})

export const BOLAGET_OWNER_TAX_OPERATIONS = [k10Get, ownerLoansGet, ku20StatusGet, k10InputsSet, ownerLoansCreate, ownerLoansUpdate, ownerLoansSetInterest] as const
