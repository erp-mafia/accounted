/**
 * Capital events in Bolaget through the machine doors: the dividend register
 * (ABL 17-18 kap.) with its per-holder split, the KU31 status per year,
 * aktieägartillskott (K2 15.5-15.6) and the changes of aktiekapital
 * (nyemission, fondemission, minskning; ABL 12, 13 and 20 kap.). The rules
 * live in src/lib/bolaget/capital; the dashboard's /api/bolaget/capital
 * routes call the same functions.
 *
 * Reads answer names and masked identities only. The KU31 file itself (it
 * carries full personnummer) has no machine door: it is downloaded in
 * Accounted by an owner or administrator. Every write stages over MCP; the
 * writes that post a verifikat are high risk.
 *
 * Every door is dark outside BOLAGET_COMPANY_IDS and for a legal form that
 * keeps no aktiebok (BOLAGET_DISABLED, BOLAGET_NOT_FOR_LEGAL_FORM).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { bolagetGate } from '@/lib/bolaget/gate'
import { bookDividend, createDividend, payDividend } from '@/lib/bolaget/capital/dividends'
import { createShareholderContribution } from '@/lib/bolaget/capital/contributions'
import { bookCapitalChange, createCapitalChange } from '@/lib/bolaget/capital/capital-changes'
import { loadKu31Status } from '@/lib/bolaget/capital/ku31'
import { loadCapitalView } from '@/lib/bolaget/capital/view'
import { CapitalChangeBookBody, ContributionCounterAccount, DividendBookBody, DividendPayBody } from '@/lib/bolaget/capital/schemas'
import {
  CAPITAL_CHANGE_KINDS,
  CAPITAL_DECIDED_BY,
  CONTRIBUTION_KINDS,
  DIVIDEND_DECIDED_BY,
  DIVIDEND_SOURCE_ACCOUNTS,
  FONDEMISSION_SOURCE_ACCOUNTS,
  MINSKNING_PURPOSES,
  RECORD_DATE_BASES,
} from '@/lib/bolaget/capital/types'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

async function gated<T>(ctx: OperationContext, run: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>> {
  const code = await bolagetGate(ctx.supabase, ctx.companyId)
  if (code) return { ok: false, code }
  return run()
}

const GATE_CODES = ['BOLAGET_DISABLED', 'BOLAGET_NOT_FOR_LEGAL_FORM']
const UUID = z.string().uuid()
const AMOUNT = z.number().positive().max(1e12)
const NAME = z.string().trim().min(1).max(200)
const PARTY_KIND = z.enum(['person', 'company'])
// A Swedish org number for a company. A personnummer is refused: it is entered in Accounted only.
const ORG = z.string().trim().max(20)
const NOTE = z.string().trim().max(2000)

// ── Outputs ──────────────────────────────────────────────────────────

const HolderOut = z.object({
  party_id: z.string(),
  name: z.string(),
  kind: PARTY_KIND,
  identity: z.string().nullable().describe('Masked personnummer (XXXXXXXX-1234) or org number.'),
  has_personnummer: z.boolean().nullable().describe('A person whose personnummer is on file (needed for KU31); null for a company.'),
})

const CapitalEventsOut = z.object({
  dividends: z.array(
    z.object({
      dividend_id: z.string(),
      decided_on: z.string(),
      decided_by: z.enum(DIVIDEND_DECIDED_BY),
      origin: z.enum(['register', 'ledger']),
      status: z.enum(['decided', 'booked', 'paid', 'cancelled']),
      amount_per_share: z.number().nullable(),
      total_amount: z.number(),
      record_date: z.string().describe('The day whose aktiebok decides who receives the dividend.'),
      record_date_basis: z.enum(RECORD_DATE_BASES),
      payment_date: z.string().describe('The betalningsdag (ABL 18:3); its year is the KU31 inkomstår.'),
      paid_on: z.string().nullable(),
      source_account: z.string().nullable(),
      prudence_confirmed: z.boolean(),
      decision_id: z.string().nullable(),
      decision_entry_id: z.string().nullable(),
      payout_entry_id: z.string().nullable(),
      note: z.string().nullable(),
      holders: z.array(HolderOut.extend({ share_count: z.number().int(), amount: z.number() })),
    }),
  ),
  contributions: z.array(
    z.object({
      shareholder_contribution_id: z.string(),
      kind: z.enum(CONTRIBUTION_KINDS).describe('contribution or repayment.'),
      party_id: z.string(),
      name: z.string(),
      holder_kind: PARTY_KIND,
      identity: z.string().nullable(),
      has_personnummer: z.boolean().nullable(),
      promised_on: z.string(),
      amount: z.number(),
      conditional: z.boolean(),
      repays_contribution_id: z.string().nullable(),
      decided_on: z.string().nullable(),
      decided_by: z.string().nullable(),
      decision_id: z.string().nullable(),
      counter_account: z.string(),
      journal_entry_id: z.string().nullable(),
      status: z.enum(['registered', 'booked', 'cancelled']),
      note: z.string().nullable(),
    }),
  ),
  capital_changes: z.array(
    z.object({
      capital_change_id: z.string(),
      kind: z.enum(CAPITAL_CHANGE_KINDS),
      kind_label: z.string(),
      decided_on: z.string(),
      decided_by: z.enum(CAPITAL_DECIDED_BY),
      decision_id: z.string().nullable(),
      share_count: z.number().int(),
      share_capital_amount: z.number(),
      price_per_share: z.number().nullable(),
      premium_amount: z.number(),
      source_account: z.string().nullable(),
      purpose: z.string().nullable(),
      target_account: z.string().nullable(),
      registered_on: z.string().nullable(),
      payment_entry_id: z.string().nullable(),
      registration_entry_id: z.string().nullable(),
      status: z.enum(['decided', 'registered', 'cancelled']),
      allotments: z.array(
        z.object({
          party_id: z.string().nullable(),
          name: z.string(),
          share_count: z.number().int(),
          amount: z.number(),
          share_register_event_id: z.string().nullable(),
        }),
      ),
      note: z.string().nullable(),
    }),
  ),
})

const Ku31StatusOut = z.object({
  income_year: z.number().int(),
  deadline: z.string(),
  schema_version: z.string(),
  file_supported: z.boolean().describe('Accounted makes the file for this inkomstår (Skatteverket schema 12.0 is for 2026).'),
  dividends: z.array(
    z.object({ dividend_id: z.string(), decided_on: z.string(), payment_date: z.string(), status: z.string(), total_amount: z.number(), origin: z.string() }),
  ),
  unbooked_dividends: z.number().int(),
  recipients: z.array(
    z.object({
      party_id: z.string(),
      name: z.string(),
      kind: PARTY_KIND,
      identity: z.string().nullable(),
      amount: z.number(),
      reported_amount: z.number().int().describe('Field 574: whole kronor, öre dropped.'),
      reported: z.boolean(),
      reason: z.enum(['legal_person', 'personnummer_missing']).nullable(),
    }),
  ),
  famansforetag: z.boolean().nullable().describe('The confirmed answer: field 061 (true) or 062 (false). Null until answered in Accounted.'),
  famansforetag_derivation: z.object({ derived: z.boolean(), top_four_votes_pct: z.number(), holders: z.number().int() }),
  contact: z.object({ name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() }),
  last_generated_at: z.string().nullable(),
  blockers: z.array(z.object({ code: z.string(), message_sv: z.string(), party_id: z.string().optional() })),
  ready: z.boolean(),
})

// ── Reads ────────────────────────────────────────────────────────────

export const capitalEventsGet = defineOperation({
  id: 'capital-events.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the capital events: dividends with the split per holder, aktieägartillskott, and nyemission, fondemission and minskning.',
    description:
      'Every dividend from the stämma decision to the payout (status decided, booked, paid) with each holder\'s part from the aktiebok on the decisive day; every aktieägartillskott, villkorat or not, and its repayments; every change of aktiekapital with its registration. Names and masked identities only.',
    useWhen: 'You need what was paid to whom, the dividends of a year, or whether an emission is registered and paid.',
    doNotUseFor: 'The aktiebok (GET /share-register) or the KU31 status of a year (GET /ku31/{year}).',
    pitfalls: ['A dividend with status decided is not booked yet: nothing is in the ledger.', 'has_personnummer false means KU31 cannot be made until the personnummer is added in Accounted.'],
    example: { response: { data: { dividends: [{ dividend_id: '4d1e…', decided_on: '2026-05-01', status: 'paid', total_amount: 100000, holders: [{ name: 'Anna Ek', amount: 100000 }] }], contributions: [], capital_changes: [] }, meta: META } },
  },
  input: z.object({}),
  output: CapitalEventsOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/capital-events' },
  mcp: {
    name: 'gnubok_get_capital_events',
    title: 'Get Capital Events',
    description: 'Read dividends (split per holder, status, verifikat), aktieägartillskott and nyemission, fondemission and minskning, with names and masked identities.',
    visibility: 'search',
    keywords: ['utdelning', 'vinstutdelning', 'aktieutdelning', 'aktieägartillskott', 'nyemission', 'fondemission', 'minskning aktiekapital', 'kapital'],
  },
  run: (ctx) => gated(ctx, async () => ({ ok: true, data: await loadCapitalView(ctx) })),
})

export const ku31StatusGet = defineOperation({
  id: 'ku31.status.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the KU31 status of an inkomstår: who received a dividend, what is reported, what still blocks the file.',
    description:
      'The dividends with a betalningsdag in the year (booked or paid), each recipient with the amount and the whole kronor field 574 reports, who is left out (Swedish legal persons), the fåmansföretag answer (field 061 or 062) and the blockers. The file itself is downloaded in Accounted by an owner or administrator: it carries personnummer.',
    useWhen: 'Before 31 January, to see whether KU31 for last year can be filed and what is missing.',
    doNotUseFor: 'Getting the file: there is no machine door for it.',
    pitfalls: ['KU31_PERSONNUMMER_MISSING: the person\'s personnummer is added in Accounted (Aktiebok), never through the API.'],
    example: { response: { data: { income_year: 2026, deadline: '2027-01-31', ready: false, blockers: [{ code: 'KU31_FAMANS_UNANSWERED', message_sv: 'Svara på om bolaget är ett fåmansföretag...' }] }, meta: META } },
  },
  input: z.object({ income_year: z.coerce.number().int().min(2000).max(2099).describe('The inkomstår, e.g. 2026.') }),
  output: Ku31StatusOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/ku31/:year', pathParams: { year: 'income_year' } },
  mcp: {
    name: 'gnubok_get_ku31_status',
    title: 'Get KU31 Status',
    description: 'Read KU31 for an inkomstår: dividends paid, recipients and amounts (masked identity), the fåmansföretag answer and what blocks the file. The file is downloaded in Accounted only.',
    visibility: 'search',
    keywords: ['ku31', 'kontrolluppgift utdelning', 'kontrolluppgifter', 'fåmansföretag', 'utdelning kontrolluppgift'],
  },
  run: (ctx, input) => gated(ctx, async () => ({ ok: true, data: await loadKu31Status(ctx, input.income_year) })),
})

// ── Writes ───────────────────────────────────────────────────────────

const DividendIn = z
  .object({
    decided_on: saneIsoDateSchema.describe('The day the bolagsstämma decided the dividend (YYYY-MM-DD).'),
    decided_by: z.enum(DIVIDEND_DECIDED_BY).describe('arsstamma or extra_stamma: only a stämma decides a dividend (ABL 18:1).'),
    decision_id: UUID.nullish().describe('The stämma decision, when recorded in Accounted.'),
    document_id: UUID.nullish().describe('The minutes in the archive.'),
    amount_per_share: z.number().positive().max(1e9).nullish().describe('Amount per share in SEK (ABL 18:3). Give this or total_amount.'),
    total_amount: AMOUNT.nullish().describe('Or the total to split in proportion to the shares.'),
    share_class_ids: z.array(UUID).max(20).nullish().describe('The classes paid on; all when omitted.'),
    record_date_basis: z.enum(RECORD_DATE_BASES).nullish().describe('Which day\'s aktiebok decides the recipients: decision_date (default), payment_date or other.'),
    record_date: saneIsoDateSchema.nullish().describe('With record_date_basis other: that day.'),
    payment_date: saneIsoDateSchema.nullish().describe('The betalningsdag the stämma set (ABL 18:3); the decision day when omitted.'),
    prudence_confirmed: z.boolean().nullish().describe('The board assessed the försiktighetsregel (ABL 17:3 second paragraph).'),
    note: NOTE.nullish(),
  })
  .strict()

const DividendCreatedOut = z.object({
  dividend_id: z.string(),
  status: z.enum(['decided', 'booked', 'paid', 'cancelled']),
  total_amount: z.number(),
  record_date: z.string(),
  payment_date: z.string(),
  distributions: z.array(z.object({ party_id: z.string(), share_count: z.number().int(), amount: z.number() })),
})

export const dividendsCreate = defineOperation({
  id: 'dividends.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Record a dividend decided by the bolagsstämma and split it over the holders of the aktiebok.',
    description:
      'Records the decision (amount per share or a total, betalningsdag, which day decides the recipients) and one part per holder from the aktiebok on that day, rounded to the öre (a total is split by largest remainder). Checks it against fritt eget kapital on the last balance sheet less later transfers (ABL 17:3) and warns. Nothing is booked: book it with POST /dividends/{id}/book. Dry-runnable.',
    useWhen: 'The stämma decided a dividend.',
    doNotUseFor: 'Booking (POST /dividends/{id}/book) or a dividend already in the ledger before the aktiebok existed (the "who received" step in Accounted).',
    pitfalls: [
      'DIVIDEND_NO_HOLDERS: the aktiebok has no holders on the decisive day; register the shares first.',
      'A warning DIVIDEND_EXCEEDS_FREE_EQUITY means booking will be refused (ABL 17:3).',
    ],
    example: {
      request: { decided_on: '2026-05-01', decided_by: 'arsstamma', amount_per_share: 100, payment_date: '2026-05-15', prudence_confirmed: true },
      response: { data: { dividend_id: '4d1e…', status: 'decided', total_amount: 100000, record_date: '2026-05-01', payment_date: '2026-05-15', distributions: [{ party_id: '9c1e…', share_count: 1000, amount: 100000 }] }, meta: META },
    },
  },
  input: DividendIn,
  output: DividendCreatedOut,
  errorCodes: [...GATE_CODES, 'DIVIDEND_NO_HOLDERS', 'BOLAGET_DATES_INVALID', 'SHARE_REGISTER_AVSTAMNINGSBOLAG', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/dividends' },
  mcp: {
    name: 'gnubok_create_dividend',
    title: 'Create Dividend',
    description: 'Stage a dividend the stämma decided: per share or a total, betalningsdag, split per holder from the aktiebok, checked against fritt eget kapital. Nothing is booked until gnubok_book_dividend.',
    visibility: 'search',
    keywords: ['utdelning', 'vinstutdelning', 'aktieutdelning', 'besluta utdelning', 'årsstämma utdelning'],
    stage: {
      pendingType: 'create_dividend',
      title: (input) => `Utdelning beslutad ${typeof input.decided_on === 'string' ? input.decided_on : ''}`.trim(),
      extras: () => ({ next: { description: 'After approval, book the decision with gnubok_book_dividend (dividend_id from the result).', tool: 'gnubok_book_dividend' } }),
    },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => createDividend(ctx, input, { dryRun })),
})

export const dividendsBook = defineOperation({
  id: 'dividends.book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a decided dividend: D 2098 (or 2091) / K 2898 on the decision day, and freeze the split per holder.',
    description:
      'Posts the decision through the bookkeeping engine on the decision day: debit 2098 Vinst eller förlust från föregående år while it holds the amount, else 2091 Balanserat resultat, credit 2898 Outtagen vinstutdelning. The split is refreshed from the aktiebok once more and then frozen. Refused above the fritt eget kapital (ABL 17:3) and in a locked period. Dry-runnable.',
    useWhen: 'A dividend is recorded with status decided.',
    doNotUseFor: 'The payout (POST /dividends/{id}/pay).',
    pitfalls: ['DIVIDEND_EXCEEDS_FREE_EQUITY: lower the dividend; the stämma must decide again.', 'A locked or closed period refuses the posting; the decision day decides the period.'],
    example: { request: { dividend_id: '4d1e…' }, response: { data: { dividend_id: '4d1e…', status: 'booked', decision_entry_id: '7a2b…', source_account: DIVIDEND_SOURCE_ACCOUNTS[0], total_amount: 100000 }, meta: META } },
  },
  input: DividendBookBody.extend({ dividend_id: UUID }).strict(),
  output: z.object({
    dividend_id: z.string(),
    status: z.enum(['decided', 'booked', 'paid', 'cancelled']),
    decision_entry_id: z.string(),
    source_account: z.enum(DIVIDEND_SOURCE_ACCOUNTS),
    total_amount: z.number(),
  }),
  errorCodes: [...GATE_CODES, 'DIVIDEND_NOT_FOUND', 'DIVIDEND_STATUS_INVALID', 'DIVIDEND_EXCEEDS_FREE_EQUITY', 'DIVIDEND_NO_HOLDERS', 'CAPITAL_NO_OPEN_PERIOD'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/dividends/:id/book', pathParams: { id: 'dividend_id' } },
  mcp: {
    name: 'gnubok_book_dividend',
    title: 'Book Dividend',
    description: 'Stage the booking of a decided dividend: D 2098 or 2091 / K 2898 on the decision day; freezes the split per holder. Refused above fritt eget kapital (ABL 17:3).',
    visibility: 'search',
    keywords: ['bokför utdelning', 'utdelning 2898', 'outtagen vinstutdelning', 'beslutad utdelning'],
    stage: { pendingType: 'book_dividend', title: () => 'Bokför beslutad utdelning' },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => bookDividend(ctx, input, { dryRun })),
})

export const dividendsPay = defineOperation({
  id: 'dividends.pay',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Mark a booked dividend paid: book D 2898 / K bank, or link the payout verifikat already booked from the bank.',
    description:
      'Posts the payout through the engine on paid_on (the betalningsdag when omitted), or, with journal_entry_id, links a posted verifikat that debits 2898 instead of booking a second one. The KU31 deadline for the year is raised. Dry-runnable.',
    useWhen: 'The dividend left the bank.',
    doNotUseFor: 'A dividend not yet booked (POST /dividends/{id}/book first).',
    pitfalls: ['DIVIDEND_PAYOUT_ENTRY_INVALID: the linked verifikat is not posted or does not debit 2898.'],
    example: { request: { dividend_id: '4d1e…', paid_on: '2026-05-15' }, response: { data: { dividend_id: '4d1e…', status: 'paid', payout_entry_id: '8c3d…', paid_on: '2026-05-15', linked: false }, meta: META } },
  },
  input: DividendPayBody.extend({ dividend_id: UUID }).strict(),
  output: z.object({
    dividend_id: z.string(),
    status: z.enum(['decided', 'booked', 'paid', 'cancelled']),
    payout_entry_id: z.string(),
    paid_on: z.string(),
    linked: z.boolean(),
  }),
  errorCodes: [...GATE_CODES, 'DIVIDEND_NOT_FOUND', 'DIVIDEND_STATUS_INVALID', 'DIVIDEND_PAYOUT_ENTRY_INVALID', 'BOLAGET_DATES_INVALID', 'CAPITAL_NO_OPEN_PERIOD'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/dividends/:id/pay', pathParams: { id: 'dividend_id' } },
  mcp: {
    name: 'gnubok_pay_dividend',
    title: 'Pay Dividend',
    description: 'Stage the payout of a booked dividend: D 2898 / K bank on the payment day, or link the payout verifikat already booked from the bank.',
    visibility: 'search',
    keywords: ['utbetald utdelning', 'betala utdelning', 'utdelning utbetalning', '2898 1930'],
    stage: {
      pendingType: 'pay_dividend',
      title: (input) => `Utbetald utdelning${typeof input.paid_on === 'string' ? ` ${input.paid_on}` : ''}`,
      extras: (input) => (typeof input.paid_on === 'string' ? { periodDate: input.paid_on } : {}),
    },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => payDividend(ctx, input, { dryRun })),
})

export const shareholderContributionsCreate = defineOperation({
  id: 'shareholder-contributions.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Register and book an aktieägartillskott (villkorat or ovillkorat), or the repayment of a villkorat one.',
    description:
      'A tillskott is booked to balanserat resultat when promised (K2 15.5): D bank (or 1685 while only promised) / K 2093 Erhållna aktieägartillskott. A repayment of a villkorat tillskott (K2 15.6) books D 2093 / K bank and warns without a stämma decision or above fritt eget kapital. Name the shareholder by party_id or by name. Dry-runnable.',
    useWhen: 'A shareholder put money into the company without shares or a loan, or a villkorat tillskott is repaid.',
    doNotUseFor: 'A loan from the owner (a liability on 2393/2893) or a nyemission (POST /capital-changes).',
    pitfalls: ['CONTRIBUTION_NOT_CONDITIONAL: only a villkorat tillskott is repaid.', 'CONTRIBUTION_REPAYMENT_EXCEEDS: more than what is left of the tillskott.'],
    example: { request: { party_id: '9c1e…', promised_on: '2026-03-01', amount: 50000, conditional: true }, response: { data: { shareholder_contribution_id: '2f4a…', kind: 'contribution', party_id: '9c1e…', amount: 50000, journal_entry_id: '7a2b…' }, meta: META } },
  },
  input: z
    .object({
      kind: z.enum(CONTRIBUTION_KINDS).nullish().describe('contribution (default) or repayment.'),
      party_id: UUID.nullish().describe('The shareholder (from gnubok_get_share_register).'),
      holder_name: NAME.nullish().describe('Or the shareholder\'s name, when new.'),
      holder_kind: PARTY_KIND.nullish(),
      holder_org_number: ORG.nullish().describe('A company shareholder\'s org number. Never a personnummer.'),
      promised_on: saneIsoDateSchema.describe('Contribution: the day it was promised (utfästelse). Repayment: the payment day.'),
      amount: AMOUNT,
      conditional: z.boolean().nullish().describe('Villkorat: may be repaid out of distributable equity.'),
      repays_contribution_id: UUID.nullish().describe('Repayment: the villkorat tillskott repaid.'),
      decided_on: saneIsoDateSchema.nullish(),
      decided_by: z.enum(CAPITAL_DECIDED_BY).nullish(),
      decision_id: UUID.nullish(),
      document_id: UUID.nullish().describe('The tillskott agreement in the archive.'),
      counter_account: ContributionCounterAccount.nullish(),
      note: NOTE.nullish(),
    })
    .strict(),
  output: z.object({
    shareholder_contribution_id: z.string(),
    kind: z.enum(CONTRIBUTION_KINDS),
    party_id: z.string(),
    amount: z.number(),
    journal_entry_id: z.string(),
  }),
  errorCodes: [...GATE_CODES, 'CONTRIBUTION_NOT_FOUND', 'CONTRIBUTION_NOT_CONDITIONAL', 'CONTRIBUTION_REPAYMENT_EXCEEDS', 'BOLAGET_PARTY_NOT_FOUND', 'BOLAGET_PARTY_INVALID', 'BOLAGET_PERSONNUMMER_IN_APP_ONLY', 'CAPITAL_NO_OPEN_PERIOD'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/shareholder-contributions' },
  mcp: {
    name: 'gnubok_create_shareholder_contribution',
    title: 'Create Shareholder Contribution',
    description: 'Stage an aktieägartillskott (villkorat or ovillkorat): booked D bank / K 2093 (K2 15.5); or the repayment of a villkorat one, D 2093 / K bank.',
    visibility: 'search',
    keywords: ['aktieägartillskott', 'villkorat aktieägartillskott', 'ovillkorat aktieägartillskott', 'kapitaltillskott', 'återbetalning tillskott'],
    stage: { pendingType: 'create_shareholder_contribution', title: (input) => (input.kind === 'repayment' ? 'Återbetalning av aktieägartillskott' : 'Aktieägartillskott') },
  },
  run: (ctx, input, { dryRun }) =>
    gated(ctx, () =>
      createShareholderContribution(
        ctx,
        {
          ...input,
          holder: { party_id: input.party_id ?? null, name: input.holder_name ?? null, kind: input.holder_kind ?? null, org_number: input.holder_org_number ?? null },
        },
        { dryRun },
      ),
    ),
})

export const capitalChangesCreate = defineOperation({
  id: 'capital-changes.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Record a nyemission, fondemission or minskning av aktiekapitalet, with its allotment and its filing deadlines.',
    description:
      'Records the decision and the change of aktiekapital (kvotvärde x shares when omitted). A nyemission\'s allotment goes into the aktiebok genast (ABL 13:18). Raises the deadlines: nyemission 6 months (13:27), fondemission genast (12:10), minskning 4 months (20:19) and the notice to the holders (20:18). Nothing is booked: POST /capital-changes/{id}/book. Dry-runnable.',
    useWhen: 'The stämma (or the board under an authorisation) decided to change the aktiekapital.',
    doNotUseFor: 'A share transfer (POST /share-register/events) or a dividend (POST /dividends).',
    pitfalls: ['The allotment must add up to share_count.', 'Fondemission and minskning shares are entered in the aktiebok after registration.'],
    example: { request: { kind: 'nyemission', decided_on: '2026-09-01', decided_by: 'extra_stamma', share_count: 100, price_per_share: 1000, allotments: [{ party_id: '9c1e…', share_count: 100 }] }, response: { data: { capital_change_id: '5e6f…', kind: 'nyemission', share_capital_amount: 2500, premium_amount: 97500, share_register_event_ids: ['7a2b…'] }, meta: META } },
  },
  input: z
    .object({
      kind: z.enum(CAPITAL_CHANGE_KINDS),
      decided_on: saneIsoDateSchema,
      decided_by: z.enum(CAPITAL_DECIDED_BY),
      decision_id: UUID.nullish(),
      document_id: UUID.nullish(),
      share_class_id: UUID.nullish().describe('The class; optional with one class.'),
      share_count: z.number().int().min(0).max(1_000_000_000).describe('New shares (emission) or cancelled shares (minskning); 0 when only the kvotvärde changes.'),
      share_capital_amount: AMOUNT.nullish().describe('The change of aktiekapital; kvotvärde x share_count when omitted.'),
      price_per_share: z.number().positive().max(1e9).nullish().describe('Nyemission: the subscription price per share.'),
      subscription_start: saneIsoDateSchema.nullish(),
      subscription_end: saneIsoDateSchema.nullish(),
      source_account: z.enum(FONDEMISSION_SOURCE_ACCOUNTS).nullish().describe('Fondemission: the fund (ABL 12:1); 2091 when omitted.'),
      purpose: z.enum(MINSKNING_PURPOSES).nullish().describe('Minskning: forlusttackning, aterbetalning or fri_fond (ABL 20:1).'),
      allotments: z
        .array(
          z
            .object({
              party_id: UUID.nullish(),
              name: NAME.nullish(),
              kind: PARTY_KIND.nullish(),
              org_number: ORG.nullish(),
              share_count: z.number().int().min(1),
            })
            .strict(),
        )
        .max(200)
        .nullish()
        .describe('Nyemission: who was allotted how many shares.'),
      allotted_on: saneIsoDateSchema.nullish().describe('The allotment day; the decision day when omitted.'),
      note: NOTE.nullish(),
    })
    .strict(),
  output: z.object({
    capital_change_id: z.string(),
    kind: z.enum(CAPITAL_CHANGE_KINDS),
    share_capital_amount: z.number(),
    premium_amount: z.number(),
    share_register_event_ids: z.array(z.string()),
  }),
  errorCodes: [...GATE_CODES, 'VALIDATION_ERROR', 'BOLAGET_DATES_INVALID', 'SHARE_REGISTER_RANGE_TAKEN', 'SHARE_CLASS_REQUIRED', 'BOLAGET_PARTY_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/capital-changes' },
  mcp: {
    name: 'gnubok_create_capital_change',
    title: 'Create Capital Change',
    description: 'Stage a nyemission (allotment into the aktiebok), fondemission or minskning av aktiekapitalet, with its Bolagsverket deadlines. Book payment and registration with gnubok_book_capital_change.',
    visibility: 'search',
    keywords: ['nyemission', 'fondemission', 'minskning av aktiekapitalet', 'emission', 'teckning', 'aktiekapital'],
    stage: { pendingType: 'create_capital_change', title: (input) => `Kapitaländring: ${typeof input.kind === 'string' ? input.kind : ''}`.trim() },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => createCapitalChange(ctx, input, { dryRun })),
})

export const capitalChangesBook = defineOperation({
  id: 'capital-changes.book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a capital change: a nyemission\'s payment (D bank / K 2082, 2097), or the registration of any change.',
    description:
      'step payment (nyemission only): D bank / K 2082 Ej registrerat aktiekapital and 2097 Fri överkursfond. step registration on the Bolagsverket registration day: nyemission D 2082 / K 2081 (13:29; payment must be booked first, 13:28), fondemission D the fund / K 2081 (12:10), minskning D 2081 / K 2091 or 2890 (20:20). Dry-runnable.',
    useWhen: 'The subscription money came in, or Bolagsverket registered the change.',
    doNotUseFor: 'Recording the decision (POST /capital-changes).',
    pitfalls: ['CAPITAL_CHANGE_NOT_PAID: book the payment before the registration.'],
    example: { request: { capital_change_id: '5e6f…', step: 'registration', date: '2026-10-01' }, response: { data: { capital_change_id: '5e6f…', step: 'registration', journal_entry_id: '7a2b…', status: 'registered' }, meta: META } },
  },
  input: CapitalChangeBookBody.extend({ capital_change_id: UUID }).strict(),
  output: z.object({
    capital_change_id: z.string(),
    step: z.enum(['payment', 'registration']),
    journal_entry_id: z.string(),
    status: z.enum(['decided', 'registered', 'cancelled']),
  }),
  errorCodes: [...GATE_CODES, 'CAPITAL_CHANGE_NOT_FOUND', 'CAPITAL_CHANGE_STATUS_INVALID', 'CAPITAL_CHANGE_NOT_PAID', 'BOLAGET_DATES_INVALID', 'CAPITAL_NO_OPEN_PERIOD'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/capital-changes/:id/book', pathParams: { id: 'capital_change_id' } },
  mcp: {
    name: 'gnubok_book_capital_change',
    title: 'Book Capital Change',
    description: 'Stage the booking of a capital change: a nyemission payment (D bank / K 2082, 2097) or a registration (2082 to 2081, fund to 2081, or 2081 out).',
    visibility: 'search',
    keywords: ['bokför nyemission', 'registrerad nyemission', 'ej registrerat aktiekapital', 'fondemission bokföring', 'minskning bokföring'],
    stage: {
      pendingType: 'book_capital_change',
      title: (input) => (input.step === 'payment' ? 'Inbetalning av nyemission' : 'Registrerad kapitaländring'),
      extras: (input) => (typeof input.date === 'string' ? { periodDate: input.date } : {}),
    },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => bookCapitalChange(ctx, input, { dryRun })),
})

export const BOLAGET_CAPITAL_OPERATIONS = [
  capitalEventsGet,
  ku31StatusGet,
  dividendsCreate,
  dividendsBook,
  dividendsPay,
  shareholderContributionsCreate,
  capitalChangesCreate,
  capitalChangesBook,
] as const
