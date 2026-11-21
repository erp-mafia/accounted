/**
 * The Bolaget registers through the machine doors: the aktiebok (ABL 5 kap.),
 * the share classes, the roles over time with the firmateckning, and the
 * verkliga huvudmän (LRVH). The rules live in src/lib/bolaget; the
 * dashboard's /api/bolaget routes call the same functions.
 *
 * Reads answer names and masked identities only. A personnummer never
 * travels these doors: the inputs name a person by party_id or by name, and
 * the person's identity is completed in Accounted (Aktiebok).
 * Every write stages over MCP and a person approves it. Every write is an
 * owner's or admin's (FORBIDDEN for a member), staged or approved.
 *
 * Every door is dark outside BOLAGET_COMPANY_IDS and for a legal form that
 * keeps no aktiebok (BOLAGET_DISABLED, BOLAGET_NOT_FOR_LEGAL_FORM).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { bolagetGate } from '@/lib/bolaget/gate'
import { BO_CONTROL_KINDS, confirmBeneficialOwners, loadBeneficialOwnerView } from '@/lib/bolaget/beneficial-owners'
import { addCompanyRole, endCompanyRole, loadRoles, setSignatoryRule } from '@/lib/bolaget/roles'
import { createShareClass, loadShareRegisterData, registerShareEvent, updateShareClass } from '@/lib/bolaget/share-register'
import { rolesView, shareEventsView, shareRegisterView } from '@/lib/bolaget/view'
import { COMPANY_ROLE_KINDS, SHARE_EVENT_KINDS, TRANSFER_REASONS, type ShareClass } from '@/lib/bolaget/types'
import { requireCompanyAdmin } from './access'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

async function gated<T>(ctx: OperationContext, run: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>> {
  // The register operations (aktiebok, roles, signatory rules, beneficial owners).
  const code = await bolagetGate(ctx.supabase, ctx.companyId, 'registers')
  if (code) return { ok: false, code }
  return run()
}

// The same sentence as the dashboard's owner/admin refusal (companyAdminRequiredResponse).
const ADMIN_MESSAGE = 'Bara företagets ägare eller en administratör kan göra det här.'

/**
 * The ownership and signatory registers are an owner's or admin's, as their
 * dashboard routes are (requireAdmin). v1 and MCP run as the service role, so
 * the role is checked here, on a dry run too: an MCP stage by a member is
 * refused up front and an approval checks the approving user.
 */
async function adminGated<T>(ctx: OperationContext, run: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>> {
  return gated(ctx, async () => {
    const refused = await requireCompanyAdmin(ctx, ADMIN_MESSAGE)
    return refused ?? run()
  })
}

const GATE_CODES = ['BOLAGET_DISABLED', 'BOLAGET_NOT_FOR_LEGAL_FORM']
const ADMIN_WRITE_CODES = [...GATE_CODES, 'FORBIDDEN']
const AS_OF = saneIsoDateSchema.optional().describe('The day the answer is for (YYYY-MM-DD). Default today.')
const PARTY_ID = z.string().uuid()
const NAME = z.string().trim().min(1).max(200)
const KIND = z.enum(['person', 'company'])
// A Swedish org number for a company holder. A personnummer is refused: it is entered in Accounted only.
const ORG = z.string().trim().max(20)

// ── Outputs ──────────────────────────────────────────────────────────

const RangeOut = z.object({ range_start: z.number().int(), range_end: z.number().int(), share_class_id: z.string() })

const ShareRegisterOut = z.object({
  as_of: z.string(),
  is_avstamningsbolag: z.boolean().describe('The central securities depository keeps the aktiebok; this register takes no entries.'),
  total_shares: z.number().int(),
  total_votes: z.number(),
  next_free_share_number: z.number().int().describe('Where the next issue starts.'),
  classes: z.array(
    z.object({
      share_class_id: z.string(),
      code: z.string(),
      name: z.string().nullable(),
      votes_per_share: z.number(),
      forbehall_samtycke: z.boolean(),
      forbehall_forkop: z.boolean(),
      forbehall_hembud: z.boolean(),
      forbehall_omvandling: z.boolean(),
      forbehall_inlosen: z.boolean(),
      forbehall_text: z.string().nullable(),
      bolagsordning_reference: z.string().nullable(),
      shares: z.number().int(),
      votes: z.number(),
    }),
  ),
  holders: z.array(
    z.object({
      party_id: z.string(),
      name: z.string(),
      kind: KIND,
      identity: z.string().nullable().describe('Masked personnummer (XXXXXXXX-1234), org number, or masked foreign identity number; null when not on file.'),
      has_address: z.boolean(),
      shares: z.number().int(),
      votes: z.number(),
      capital_pct: z.number(),
      votes_pct: z.number(),
      by_class: z.array(z.object({ share_class_id: z.string(), code: z.string(), shares: z.number().int() })),
      ranges: z.array(RangeOut),
      officer: z.boolean().describe('Board member, suppleant or VD on as_of (ABL 8:45).'),
    }),
  ),
  notes: z.array(
    z.object({
      kind: z.enum(['aktiebrev', 'pant', 'nyttjanderatt']),
      range_start: z.number().int(),
      range_end: z.number().int(),
      aktiebrev_number: z.string().nullable(),
      counterparty_party_id: z.string().nullable(),
      counterparty_name: z.string().nullable(),
      event_number: z.number().int(),
      event_date: z.string(),
    }),
  ),
  reconciliation: z.object({
    status: z.enum(['match', 'mismatch', 'settings_empty', 'register_empty', 'both_empty']),
    register_shares: z.number().int(),
    settings_shares: z.number().int().nullable(),
    aktiekapital: z.number().nullable(),
    kvotvarde: z.number().nullable(),
  }),
  incomplete: z.object({ without_identity: z.number().int(), without_address: z.number().int() }),
  note_problems: z
    .array(
      z.object({
        share_register_event_id: z.string(),
        event_number: z.number().int(),
        event_date: z.string(),
        kind: z.enum(['aktiebrev', 'pant', 'nyttjanderatt']),
        message: z.string(),
      }),
    )
    .describe('Stored aktiebrev, pant or nyttjanderätt entries the history cannot hold. They are left out of notes; void each with a rattelse entry.'),
  events_count: z.number().int(),
  last_event_number: z.number().int().describe('The number of the newest entry, 0 when there is none. Send it as expected_last_event_number with a new entry.'),
})

const ShareEventOut = z.object({
  share_register_event_id: z.string(),
  event_number: z.number().int(),
  event_date: z.string(),
  entered_at: z.string(),
  kind: z.enum(SHARE_EVENT_KINDS),
  kind_label: z.string(),
  text: z.string().describe('The entry as a Swedish sentence.'),
  voided: z.boolean().describe('A later rattelse entry voided this one.'),
  corrects_event_id: z.string().nullable(),
  share_class_id: z.string().nullable(),
  from_party_id: z.string().nullable(),
  to_party_id: z.string().nullable(),
  counterparty_party_id: z.string().nullable(),
  range_start: z.number().int().nullable(),
  range_end: z.number().int().nullable(),
  transfer_reason: z.string().nullable(),
  price_total: z.number().nullable(),
  ratio: z.number().int().nullable(),
  aktiebrev_number: z.string().nullable(),
  aktiebrev_action: z.enum(['issued', 'returned']).nullable(),
  note_status: z.enum(['open', 'closed']).nullable(),
  registered_on: z.string().nullable(),
  decision_id: z.string().nullable(),
  document_id: z.string().nullable(),
  journal_entry_id: z.string().nullable(),
  note: z.string().nullable(),
})

const RoleOut = z.object({
  company_role_id: z.string(),
  party_id: z.string(),
  name: z.string(),
  kind: KIND,
  identity: z.string().nullable(),
  role: z.enum(COMPANY_ROLE_KINDS),
  role_label: z.string(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  active: z.boolean(),
  source: z.enum(['registry_tic', 'person', 'decision', 'document']),
  registered_at: z.string().nullable(),
  decision_id: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
})

const RolesOut = z.object({
  as_of: z.string(),
  signatory_rule: z.string().nullable().describe('The firmateckning in force on as_of.'),
  roles: z.array(RoleOut),
  signatory_rules: z.array(
    z.object({
      signatory_rule_id: z.string(),
      rule_text: z.string(),
      valid_from: z.string().nullable(),
      valid_to: z.string().nullable(),
      active: z.boolean(),
      source: z.enum(['registry_tic', 'person', 'decision', 'document']),
      registered_at: z.string().nullable(),
    }),
  ),
})

const BoCandidateOut = z.object({
  party_id: z.string(),
  name: z.string(),
  kind: KIND,
  votes_pct: z.number(),
  capital_pct: z.number(),
  extent: z.string(),
})

const BoOut = z.object({
  proposal: z.object({
    as_of: z.string(),
    owners: z.array(BoCandidateOut).describe('Natural persons with more than 25 % of the votes (LRVH 1:3).'),
    indirect: z.array(BoCandidateOut).describe('Companies with more than 25 %: find out who controls them.'),
    conclusion: z.enum(['owners_identified', 'no_beneficial_owner']),
  }),
  confirmed: z.array(z.object({ company_role_id: z.string(), party_id: z.string(), name: z.string(), extent: z.string().nullable(), valid_from: z.string().nullable() })),
  assessments: z.array(
    z.object({
      beneficial_owner_assessment_id: z.string(),
      assessed_on: z.string(),
      basis: z.string(),
      conclusion: z.enum(['owners_identified', 'no_beneficial_owner']),
      owners: z.array(z.record(z.string(), z.unknown())),
      family_aggregation_checked: z.boolean(),
      family_note: z.string().nullable(),
      control_agreements: z.boolean(),
      control_note: z.string().nullable(),
      changed: z.boolean(),
      created_at: z.string(),
    }),
  ),
  differs: z.boolean().describe('The proposal names other persons than those confirmed: a new assessment is due.'),
  filing_url: z.string(),
})

const ShareClassOut = z.object({
  share_class_id: z.string(),
  code: z.string(),
  name: z.string().nullable(),
  votes_per_share: z.number(),
  forbehall_samtycke: z.boolean(),
  forbehall_forkop: z.boolean(),
  forbehall_hembud: z.boolean(),
  forbehall_omvandling: z.boolean(),
  forbehall_inlosen: z.boolean(),
  forbehall_text: z.string().nullable(),
  bolagsordning_reference: z.string().nullable(),
})

/** A share class with a qualified id, as every door answers it. */
function classOutcome(outcome: OperationOutcome<ShareClass>): OperationOutcome<z.infer<typeof ShareClassOut>> {
  if (!outcome.ok || outcome.dryRun) return outcome
  const { id, ...rest } = outcome.data
  return { ...outcome, data: { share_class_id: id, ...rest } }
}

// ── Reads ────────────────────────────────────────────────────────────

export const shareRegisterGet = defineOperation({
  id: 'share-register.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the aktiebok as of a date: holders with shares, votes and percent, share numbers, classes and notes.',
    description:
      'The share register (ABL 5 kap.) replayed to as_of: every holder with masked identity, shares and votes, share of capital and votes, share-number ranges, and whether they are on the board or VD (ABL 8:45); the classes with their förbehåll; open notes (aktiebrev, pant, nyttjanderätt); and a check against company_settings.antal_aktier.',
    useWhen: 'You need who owns the company, how much, or the number range of someone\'s shares.',
    doNotUseFor: 'The dated history of entries (GET /share-register/events) or the board (GET /company-roles).',
    pitfalls: ['identity is masked; the full personnummer is never answered.', 'reconciliation.status mismatch means the register and company_settings.antal_aktier disagree; ask the person which is right.'],
    example: { response: { data: { as_of: '2026-10-29', total_shares: 1000, holders: [{ party_id: '9c1e…', name: 'Anna Ek', shares: 1000, capital_pct: 100, votes_pct: 100 }] }, meta: META } },
  },
  input: z.object({ as_of: AS_OF }),
  output: ShareRegisterOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/share-register' },
  mcp: {
    name: 'gnubok_get_share_register',
    title: 'Get Share Register',
    description: 'Read the aktiebok as of a date: owners with shares, votes and percent (masked identity), share-number ranges, classes, förbehåll and open notes.',
    visibility: 'search',
    keywords: ['aktiebok', 'aktieägare', 'ägare', 'ägarförteckning', 'aktieägarförteckning', 'cap table', 'ägarandel', 'röstandel'],
  },
  run: (ctx, input) =>
    gated(ctx, async () => {
      const [data, roles] = await Promise.all([loadShareRegisterData(ctx, input.as_of ?? null), loadRoles(ctx, input.as_of ?? null)])
      return { ok: true, data: shareRegisterView(data, roles) }
    }),
})

export const shareRegisterEventsList = defineOperation({
  id: 'share-register.events.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List every aktiebok entry in entry order, each with a Swedish sentence and whether a rättelse voided it.',
    description: 'The dated history of the share register (ABL 5:9): bildande, emissions, transfers with reason and price, cancellations, conversions, splits, aktiebrev, pledges, usufruct, notes and corrections. Entries are never changed; a rattelse entry voids one.',
    useWhen: 'You need when and how ownership changed, or the entry to correct.',
    doNotUseFor: 'Current holdings (GET /share-register).',
    pitfalls: ['An entry with voided true does not count; its correction is the later rattelse entry.'],
    example: { response: { data: { events: [{ share_register_event_id: '7a2b…', event_number: 1, event_date: '2020-01-10', kind: 'bildande', text: 'Bildande: aktie 1-1 000 (1 000 st, serie A) till Anna Ek', voided: false }] }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ events: z.array(ShareEventOut) }),
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/share-register/events' },
  mcp: {
    name: 'gnubok_list_share_events',
    title: 'List Share Register Events',
    description: 'List the aktiebok history: every dated entry (issues, transfers with reason and price, cancellations, aktiebrev, pledges, corrections) in entry order.',
    visibility: 'search',
    keywords: ['aktiebok historik', 'överlåtelse aktier', 'aktieöverlåtelse', 'nyemission', 'aktiebrev', 'pantsättning aktier'],
  },
  run: (ctx) =>
    gated(ctx, async () => {
      const data = await loadShareRegisterData(ctx, null)
      return { ok: true, data: { events: shareEventsView(data) } }
    }),
})

export const companyRolesList = defineOperation({
  id: 'company-roles.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s roles over time (board, VD, firmatecknare, revisor, verkliga huvudmän) and the firmateckning.',
    description:
      'Every role with valid_from and valid_to, and whether it holds on as_of; the firmateckning text in force. The first read for a company without roles seeds them from the registry data Accounted already holds (no registry call).',
    useWhen: 'You need who is on the board, who is VD, who signs for the company or who the beneficial owners are.',
    doNotUseFor: 'Shareholdings (GET /share-register).',
    pitfalls: ['A role with source registry_tic came from the registry snapshot; check it against Bolagsverket before relying on it for a filing.'],
    example: { response: { data: { as_of: '2026-10-29', signatory_rule: 'Firman tecknas av styrelsen', roles: [{ company_role_id: '1f3c…', name: 'Anna Ek', role: 'styrelseledamot', active: true }] }, meta: META } },
  },
  input: z.object({ as_of: AS_OF }),
  output: RolesOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/company-roles' },
  mcp: {
    name: 'gnubok_list_company_roles',
    title: 'List Company Roles',
    description: 'List board members, VD, firmatecknare, revisor and verkliga huvudmän over time, and the firmateckning in force.',
    visibility: 'search',
    keywords: ['styrelse', 'styrelseledamot', 'vd', 'verkställande direktör', 'firmatecknare', 'firmateckning', 'revisor', 'verklig huvudman'],
  },
  run: (ctx, input) =>
    gated(ctx, async () => {
      const roles = await loadRoles(ctx, input.as_of ?? null)
      return { ok: true, data: rolesView(roles) }
    }),
})

export const beneficialOwnersGet = defineOperation({
  id: 'beneficial-owners.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the verkliga huvudmän: the proposal from the aktiebok, the confirmed set and the record of assessments.',
    description:
      'The proposal names every natural person with more than 25 % of the votes (LRVH 1:3) and lists companies above 25 % for investigation. Close family holdings (1:5) and control by agreement are for the company to confirm. differs is true when a new assessment is due.',
    useWhen: 'A bank asks for the company\'s beneficial owners, or ownership has changed.',
    doNotUseFor: 'Filing with Bolagsverket: that is done in Bolagsverket\'s e-service (filing_url) by an authorised representative.',
    pitfalls: ['The proposal is not the answer: a person confirms it with gnubok_confirm_beneficial_owners.'],
    example: { response: { data: { proposal: { owners: [{ name: 'Anna Ek', votes_pct: 60 }], conclusion: 'owners_identified' }, differs: true }, meta: META } },
  },
  input: z.object({ as_of: AS_OF }),
  output: BoOut,
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/beneficial-owners' },
  mcp: {
    name: 'gnubok_get_beneficial_owners',
    title: 'Get Beneficial Owners',
    description: 'Read the verkliga huvudmän proposed from the aktiebok (over 25 % of votes), the confirmed set and earlier assessments.',
    visibility: 'search',
    keywords: ['verklig huvudman', 'verkliga huvudmän', 'beneficial owner', 'kyc', 'penningtvätt', 'ägarkontroll'],
  },
  run: (ctx, input) =>
    gated(ctx, async () => {
      const view = await loadBeneficialOwnerView(ctx, input.as_of ?? null)
      return { ok: true, data: view }
    }),
})

// ── Writes ───────────────────────────────────────────────────────────

const ShareEventIn = z
  .object({
    kind: z.enum(SHARE_EVENT_KINDS).describe('bildande, nyemission, fondemission, overlatelse, indragning, omvandling, split, sammanlaggning, aktiebrev, pant, nyttjanderatt, anteckning or rattelse.'),
    event_date: saneIsoDateSchema.describe('The day the change took effect (YYYY-MM-DD); never in the future.'),
    share_class_code: z.string().trim().max(12).nullish().describe('The class, e.g. A. Optional when the company has one class; the first issue creates class A.'),
    to_share_class_code: z.string().trim().max(12).nullish().describe('omvandling: the class the shares become.'),
    from_party_id: PARTY_ID.nullish().describe('overlatelse, indragning, omvandling: the current holder (party_id from gnubok_get_share_register).'),
    to_party_id: PARTY_ID.nullish().describe('Issues and overlatelse: the receiving party, when already in the register.'),
    to_name: NAME.nullish().describe('Or the receiver\'s name, for a new holder.'),
    to_kind: KIND.nullish().describe('person (default) or company.'),
    to_org_number: ORG.nullish().describe('A company receiver\'s org number. Never a personnummer.'),
    range_start: z.number().int().min(1).nullish().describe('First share number.'),
    range_end: z.number().int().min(1).nullish().describe('Last share number.'),
    share_count: z.number().int().min(1).max(1_000_000_000).nullish().describe('Instead of a range: issues take the next free numbers, transfers the holder\'s lowest block that fits.'),
    transfer_reason: z.enum(TRANSFER_REASONS).nullish().describe('overlatelse: kop, gava, arv, testamente, bodelning, byte, apport or annat.'),
    price_total: z.number().min(0).max(1e13).nullish().describe('Price or subscription amount in SEK, if any.'),
    ratio: z.number().int().min(2).max(1_000_000).nullish().describe('split: each share becomes ratio; sammanlaggning: ratio shares become one.'),
    aktiebrev_number: z.string().trim().max(40).nullish().describe('aktiebrev: its number.'),
    aktiebrev_action: z.enum(['issued', 'returned']).nullish().describe('aktiebrev: issued, or returned (makulerat).'),
    counterparty_party_id: PARTY_ID.nullish().describe('pant: the pledgee; nyttjanderatt: the holder of the right.'),
    counterparty_name: NAME.nullish().describe('Or their name, when new.'),
    counterparty_kind: KIND.nullish(),
    counterparty_org_number: ORG.nullish(),
    note_status: z.enum(['open', 'closed']).nullish().describe('pant, nyttjanderatt: open or end the note.'),
    corrects_event_id: z.string().uuid().nullish().describe('rattelse: the entry it voids. Enter the correct entry separately.'),
    registered_on: saneIsoDateSchema.nullish().describe('Emissions: the day Bolagsverket registered the decision.'),
    decision_id: z.string().uuid().nullish(),
    document_id: z.string().uuid().nullish().describe('The underlying document in the archive (avtal, protokoll).'),
    note: z.string().trim().max(2000).nullish().describe('Free text; required for anteckning and rattelse (the reason).'),
    forbehall_cleared: z.boolean().nullish().describe('overlatelse: the class\'s samtycke, förköp or hembud has been handled.'),
    to_is_new: z.boolean().nullish().describe('to_name is somebody new although a person with that name is already in the registers (otherwise the entry is made for that person, and the preview says so).'),
    counterparty_is_new: z.boolean().nullish().describe('counterparty_name is somebody new although a person with that name is already in the registers.'),
    expected_last_event_number: z.number().int().min(0).nullish().describe('last_event_number from the preview or from gnubok_get_share_register. When the register has a newer entry the write is refused with SHARE_REGISTER_STALE instead of landing on a register you have not seen.'),
  })
  .strict()

export const shareRegisterEventsCreate = defineOperation({
  id: 'share-register.events.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Add a dated entry to the aktiebok: an issue, a transfer, a cancellation, a conversion, a split, an aktiebrev, a pledge or a note.',
    description:
      'Entries are kept forever (ABL 5:3) and numbered in sequence; a mistake is voided with kind rattelse and entered again. The register refuses an entry its history cannot hold: no share held twice, a transfer only of shares the transferor holds on that date. ' +
      'A new holder is named by to_name; their personnummer and address are completed in Accounted. Dry-runnable: the preview shows holdings before and after.',
    useWhen: 'Shares were issued, sold, given, inherited, cancelled, split, pledged, or an aktiebrev was issued or returned.',
    doNotUseFor: 'Booking the money of an emission or a dividend (a voucher), or changing votes per share (PATCH /share-classes/{id}).',
    pitfalls: [
      'SHARE_REGISTER_NOT_HELD: the from-holder does not hold all of the shares on event_date.',
      'SHARE_REGISTER_RANGE_TAKEN: an issue overlaps shares already held; omit the range and send share_count.',
      'SHARE_REGISTER_STALE: the register got an entry after the one you saw; read it again and retry.',
      'A range_start with a share_count names the whole block (range_start to range_start + share_count - 1).',
      'FORBIDDEN: only the company\'s owner or an administrator adds to the aktiebok.',
      'BOLAGET_PERSONNUMMER_IN_APP_ONLY: a personnummer was sent; name the person and complete them in the app.',
      'A transfer of a class with samtycke, förköp or hembud answers a warning until forbehall_cleared is true.',
    ],
    example: {
      request: { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: '9c1e…', to_name: 'Bo Ek', share_count: 100, transfer_reason: 'gava' },
      response: { data: { share_register_event_id: '7a2b…', event_number: 4, kind: 'overlatelse', event_date: '2026-10-01', range_start: 1, range_end: 100 }, meta: META },
    },
  },
  input: ShareEventIn,
  output: z.object({
    share_register_event_id: z.string(),
    event_number: z.number().int(),
    kind: z.enum(SHARE_EVENT_KINDS),
    event_date: z.string(),
    range_start: z.number().int().nullable(),
    range_end: z.number().int().nullable(),
    share_class_id: z.string().nullable(),
    from_party_id: z.string().nullable(),
    to_party_id: z.string().nullable(),
  }),
  errorCodes: [
    ...ADMIN_WRITE_CODES,
    'SHARE_REGISTER_NOT_HELD',
    'SHARE_REGISTER_RANGE_TAKEN',
    'SHARE_REGISTER_RANGE_REQUIRED',
    'SHARE_REGISTER_RATIO_MISALIGNED',
    'SHARE_REGISTER_NOTE_INVALID',
    'SHARE_REGISTER_CORRECTION_INVALID',
    'SHARE_REGISTER_AVSTAMNINGSBOLAG',
    'SHARE_REGISTER_STALE',
    'SHARE_CLASS_NOT_FOUND',
    'SHARE_CLASS_REQUIRED',
    'BOLAGET_PARTY_NOT_FOUND',
    'BOLAGET_PARTY_INVALID',
    'BOLAGET_PERSONNUMMER_IN_APP_ONLY',
    'BOLAGET_DATES_INVALID',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/share-register/events' },
  mcp: {
    name: 'gnubok_register_share_event',
    title: 'Register Share Event',
    description:
      'Stage an aktiebok entry: issue, transfer (reason, price), cancellation, conversion, split, aktiebrev, pledge, usufruct, note or rattelse. Name new holders; personnummer is added in Accounted only.',
    visibility: 'search',
    keywords: ['aktiebok', 'överlåtelse', 'köp av aktier', 'gåva aktier', 'arv aktier', 'nyemission', 'fondemission', 'aktiebrev', 'pantsättning', 'aktieägare', 'bildande'],
    stage: {
      pendingType: 'register_share_event',
      title: (input) => {
        const kind = typeof input.kind === 'string' ? input.kind : 'anteckning'
        const label = SHARE_EVENT_LABEL_FOR_TITLE[kind] ?? 'Anteckning'
        return `Aktiebok: ${label}${typeof input.event_date === 'string' ? ` ${input.event_date}` : ''}`
      },
      extras: (input) => ({
        next: {
          description: 'After approval, read the register with gnubok_get_share_register. A new person holder needs personnummer and address in Accounted (Aktiebok).',
          tool: 'gnubok_get_share_register',
          ...(typeof input.event_date === 'string' ? { args: { as_of: input.event_date } } : {}),
        },
      }),
    },
  },
  run: (ctx, input, { dryRun }) =>
    adminGated(ctx, () => registerShareEvent(ctx, { ...input, created_via: ctx.pendingOperationId ? 'mcp' : 'api' }, { dryRun })),
})

const SHARE_EVENT_LABEL_FOR_TITLE: Record<string, string> = {
  bildande: 'bildande',
  nyemission: 'nyemission',
  fondemission: 'fondemission',
  overlatelse: 'överlåtelse',
  indragning: 'indragning',
  omvandling: 'omvandling',
  split: 'split',
  sammanlaggning: 'sammanläggning',
  aktiebrev: 'aktiebrev',
  pant: 'pantsättning',
  nyttjanderatt: 'nyttjanderätt',
  anteckning: 'anteckning',
  rattelse: 'rättelse',
}

const ForbehallIn = {
  forbehall_samtycke: z.boolean().optional().describe('Samtyckesförbehåll (ABL 4:8).'),
  forbehall_forkop: z.boolean().optional().describe('Förköpsförbehåll (ABL 4:18).'),
  forbehall_hembud: z.boolean().optional().describe('Hembudsförbehåll (ABL 4:27).'),
  forbehall_omvandling: z.boolean().optional().describe('Omvandlingsförbehåll (ABL 4:6).'),
  forbehall_inlosen: z.boolean().optional().describe('Inlösenförbehåll (ABL 20:31).'),
  forbehall_text: z.string().trim().max(4000).nullish().describe('The clause as the bolagsordning words it.'),
  bolagsordning_reference: z.string().trim().max(200).nullish().describe('Where in the bolagsordning, e.g. § 9.'),
}

export const shareClassesCreate = defineOperation({
  id: 'share-classes.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Add a share class with its votes per share and the förbehåll of the bolagsordning.',
    description: 'A class (aktieslag, ABL 4:2) such as A or B. One class may carry at most ten times the votes of another (4:5): a larger ratio answers a warning. Dry-runnable.',
    useWhen: 'The bolagsordning has more than one class, or förbehåll to note.',
    doNotUseFor: 'Issuing shares (POST /share-register/events).',
    pitfalls: ['SHARE_CLASS_DUPLICATE: the code exists.'],
    example: { request: { code: 'B', votes_per_share: 1 }, response: { data: { id: '5d1c…', code: 'B', votes_per_share: 1 }, meta: META } },
  },
  input: z
    .object({
      code: z.string().trim().regex(/^[A-Za-z0-9]{1,12}$/).describe('Short code, e.g. A, B, Stam, Pref.'),
      name: z.string().trim().max(100).nullish(),
      votes_per_share: z.number().positive().max(1_000_000).describe('Votes per share, e.g. 1 or 10 (or 0.1).'),
      ...ForbehallIn,
    })
    .strict(),
  output: ShareClassOut,
  errorCodes: [...ADMIN_WRITE_CODES, 'SHARE_CLASS_DUPLICATE'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/share-classes' },
  mcp: {
    name: 'gnubok_create_share_class',
    title: 'Create Share Class',
    description: 'Stage a new share class (aktieslag) with votes per share and its förbehåll (samtycke, förköp, hembud, omvandling, inlösen).',
    visibility: 'search',
    keywords: ['aktieslag', 'a-aktier', 'b-aktier', 'röstvärde', 'förbehåll', 'hembudsförbehåll', 'förköpsförbehåll'],
    stage: { pendingType: 'create_share_class', title: (input) => `Nytt aktieslag ${typeof input.code === 'string' ? input.code : ''}`.trim() },
  },
  run: (ctx, input, { dryRun }) => adminGated(ctx, async () => classOutcome(await createShareClass(ctx, input, { dryRun }))),
})

/** The share-class change, exported for the dashboard route (which takes the id from its path). */
export const ShareClassUpdateIn = z
  .object({
    share_class_id: z.string().uuid().describe('The class (share_class_id).'),
    name: z.string().trim().max(100).nullish(),
    votes_per_share: z.number().positive().max(1_000_000).optional(),
    ...ForbehallIn,
  })
  .strict()

export const shareClassesUpdate = defineOperation({
  id: 'share-classes.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change a share class\'s name, votes per share or förbehåll; its code stays.',
    description: 'Votes per share decide the votes percent and so the verkliga huvudmän: change them only after the bolagsordning changed. Every change is kept in the audit log. Dry-runnable.',
    useWhen: 'The bolagsordning was amended, or a förbehåll was missing.',
    doNotUseFor: 'Converting shares between classes (an omvandling entry).',
    pitfalls: ['SHARE_CLASS_NOT_FOUND: wrong share_class_id.'],
    example: { request: { share_class_id: '5d1c…', votes_per_share: 10 }, response: { data: { id: '5d1c…', code: 'A', votes_per_share: 10 }, meta: META } },
  },
  input: ShareClassUpdateIn,
  output: ShareClassOut,
  errorCodes: [...ADMIN_WRITE_CODES, 'SHARE_CLASS_NOT_FOUND'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/share-classes/:id', pathParams: { id: 'share_class_id' } },
  mcp: {
    name: 'gnubok_update_share_class',
    title: 'Update Share Class',
    description: 'Stage a change to a share class: name, votes per share or förbehåll. Votes change ownership percent and beneficial owners.',
    visibility: 'search',
    keywords: ['ändra aktieslag', 'röstvärde', 'förbehåll', 'bolagsordning'],
    stage: { pendingType: 'update_share_class', title: () => 'Ändra aktieslag' },
  },
  run: (ctx, input, { dryRun }) =>
    adminGated(ctx, () => {
      const { share_class_id, ...patch } = input
      return updateShareClass(ctx, share_class_id, patch, { dryRun }).then(classOutcome)
    }),
})

export const companyRolesCreate = defineOperation({
  id: 'company-roles.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Add a role from a date: board member, chair, suppleant, VD, vice VD, firmatecknare, revisor or contact person.',
    description:
      'A role is end-dated, never deleted (POST /company-roles/{id}/end). The same person can hold several roles. A board change takes effect when Bolagsverket has the notice (ABL 8:13): registered_at records when. Dry-runnable.',
    useWhen: 'The stämma elected a board member, the board appointed a VD, or a firmatecknare was added.',
    doNotUseFor: 'Verkliga huvudmän (POST /beneficial-owners/assessments records them with the LRVH 2:1 record).',
    pitfalls: ['COMPANY_ROLE_DUPLICATE: the person already holds that role.', 'Filing the change with Bolagsverket is done at verksamt.se.'],
    example: { request: { name: 'Bo Ek', role: 'styrelseledamot', valid_from: '2026-06-15' }, response: { data: { company_role_id: '1f3c…', party_id: '9c1e…', role: 'styrelseledamot', valid_from: '2026-06-15' }, meta: META } },
  },
  input: z
    .object({
      party_id: PARTY_ID.nullish().describe('The person, when already in the register.'),
      name: NAME.nullish().describe('Or their name.'),
      kind: KIND.nullish().describe('person (default) or company (a revisionsbolag).'),
      org_number: ORG.nullish().describe('A company\'s org number. Never a personnummer.'),
      role: z.enum(COMPANY_ROLE_KINDS.filter((r) => r !== 'verklig_huvudman') as [string, ...string[]]),
      valid_from: saneIsoDateSchema.describe('First day in the role.'),
      registered_at: saneIsoDateSchema.nullish().describe('When Bolagsverket registered it.'),
      decision_id: z.string().uuid().nullish(),
    })
    .strict(),
  output: z.object({ company_role_id: z.string(), party_id: z.string(), role: z.string(), valid_from: z.string().nullable() }),
  errorCodes: [...ADMIN_WRITE_CODES, 'COMPANY_ROLE_DUPLICATE', 'BOLAGET_PARTY_NOT_FOUND', 'BOLAGET_PARTY_INVALID', 'BOLAGET_PERSONNUMMER_IN_APP_ONLY'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/company-roles' },
  mcp: {
    name: 'gnubok_add_company_role',
    title: 'Add Company Role',
    description: 'Stage a role from a date: styrelseledamot, ordförande, suppleant, VD, vice VD, särskild firmatecknare, revisor or kontaktperson.',
    visibility: 'search',
    keywords: ['ny styrelseledamot', 'ny vd', 'tillsätta vd', 'välja styrelse', 'firmatecknare', 'revisor', 'styrelseändring'],
    stage: { pendingType: 'add_company_role', title: (input) => `Ny roll: ${typeof input.role === 'string' ? input.role : ''}`.trim() },
  },
  run: (ctx, input, { dryRun }) =>
    adminGated(ctx, () =>
      addCompanyRole(
        ctx,
        {
          party: { party_id: input.party_id ?? null, name: input.name ?? null, kind: input.kind ?? null, org_number: input.org_number ?? null },
          role: input.role as never,
          valid_from: input.valid_from,
          registered_at: input.registered_at ?? null,
          source: input.decision_id ? 'decision' : 'person',
          decision_id: input.decision_id ?? null,
        },
        { dryRun },
      ),
    ),
})

/** The end of a role, exported for the dashboard route (which takes the id from its path). */
export const CompanyRoleEndIn = z
  .object({
    company_role_id: z.string().uuid().describe('The role (company_role_id).'),
    valid_to: saneIsoDateSchema.describe('Last day in the role.'),
    // Not `reason`: that name is the agent's own reason on every staging tool.
    end_reason: z.string().trim().max(500).nullish().describe('Why the role ended, kept on the role (e.g. avgick på egen begäran).'),
  })
  .strict()

export const companyRolesEnd = defineOperation({
  id: 'company-roles.end',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'End a role on a date (the last day in it). The row is kept.',
    description: 'An ended role cannot be ended again; the history stays for the records. Dry-runnable.',
    useWhen: 'A board member left, a VD resigned, a revisor was replaced.',
    doNotUseFor: 'Removing a wrongly entered role: end it on its start date and add the right one.',
    pitfalls: ['COMPANY_ROLE_ALREADY_ENDED.'],
    example: { request: { valid_to: '2026-06-14' }, response: { data: { company_role_id: '1f3c…', valid_to: '2026-06-14' }, meta: META } },
  },
  input: CompanyRoleEndIn,
  output: z.object({ company_role_id: z.string(), valid_to: z.string() }),
  errorCodes: [...ADMIN_WRITE_CODES, 'COMPANY_ROLE_NOT_FOUND', 'COMPANY_ROLE_ALREADY_ENDED', 'BOLAGET_DATES_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/company-roles/:id/end', pathParams: { id: 'company_role_id' } },
  mcp: {
    name: 'gnubok_end_company_role',
    title: 'End Company Role',
    description: 'Stage ending a role (board, VD, firmatecknare, revisor) on its last day; the history is kept.',
    visibility: 'search',
    keywords: ['avgå', 'lämna styrelsen', 'entlediga', 'vd avgår', 'avsluta roll'],
    stage: { pendingType: 'end_company_role', title: () => 'Avsluta roll' },
  },
  run: (ctx, input, { dryRun }) =>
    adminGated(ctx, () => {
      const { end_reason, ...end } = input
      return endCompanyRole(ctx, { ...end, reason: end_reason }, { dryRun })
    }),
})

export const signatoryRulesSet = defineOperation({
  id: 'signatory-rules.set',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Set the firmateckning from a date; the rule in force ends the day before.',
    description: 'The registered text, e.g. "Firman tecknas av styrelsen. Firman tecknas av två ledamöter i förening." (ABL 8:35-37). Dry-runnable.',
    useWhen: 'The board changed who signs for the company.',
    doNotUseFor: 'Adding a särskild firmatecknare as a person (POST /company-roles).',
    pitfalls: ['BOLAGET_DATES_INVALID: a rule already starts on or after valid_from.'],
    example: { request: { rule_text: 'Firman tecknas av styrelsen', valid_from: '2026-06-15' }, response: { data: { signatory_rule_id: '2b9d…', rule_text: 'Firman tecknas av styrelsen', valid_from: '2026-06-15', ended_rule_ids: [] }, meta: META } },
  },
  input: z
    .object({
      rule_text: z.string().trim().min(1).max(2000),
      valid_from: saneIsoDateSchema,
      registered_at: saneIsoDateSchema.nullish(),
      decision_id: z.string().uuid().nullish(),
    })
    .strict(),
  output: z.object({ signatory_rule_id: z.string(), rule_text: z.string(), valid_from: z.string(), ended_rule_ids: z.array(z.string()) }),
  errorCodes: [...ADMIN_WRITE_CODES, 'BOLAGET_DATES_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/signatory-rules' },
  mcp: {
    name: 'gnubok_set_signatory_rule',
    title: 'Set Signatory Rule',
    description: 'Stage a new firmateckning text from a date; the one in force ends the day before.',
    visibility: 'search',
    keywords: ['firmateckning', 'teckna firman', 'firmatecknare'],
    stage: { pendingType: 'set_signatory_rule', title: () => 'Ny firmateckning' },
  },
  run: (ctx, input, { dryRun }) =>
    adminGated(ctx, () => setSignatoryRule(ctx, { ...input, source: input.decision_id ? 'decision' : 'person' }, { dryRun })),
})

export const beneficialOwnersConfirm = defineOperation({
  id: 'beneficial-owners.confirm',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Record an assessment of the verkliga huvudmän (LRVH 2:1): who they are and why, or that there is none.',
    description:
      'Keeps the dated record (basis, conclusion, family holdings checked, control agreements), brings the verklig_huvudman roles in line, and when the set changed adds a deadline to file the change with Bolagsverket without delay (LRVH 2:3). Dry-runnable.',
    useWhen: 'After gnubok_get_beneficial_owners, once the person has confirmed the owners.',
    doNotUseFor: 'Filing with Bolagsverket: an authorised representative files in Bolagsverket\'s e-service.',
    pitfalls: ['A verklig huvudman is always a natural person: a company party is refused.', 'owners must be empty for no_beneficial_owner and not empty for owners_identified.'],
    example: {
      request: { assessed_on: '2026-10-29', conclusion: 'owners_identified', owners: [{ party_id: '9c1e…' }], family_aggregation_checked: true, control_agreements: false },
      response: { data: { beneficial_owner_assessment_id: '3e7f…', changed: true, ended_role_ids: [], added_role_ids: ['8d2a…'], deadline_source_key: 'bolaget:verklig-huvudman:3e7f…', filing_url: 'https://bolagsverket.se/…' }, meta: META },
    },
  },
  input: z
    .object({
      assessed_on: saneIsoDateSchema.describe('The day of the investigation.'),
      conclusion: z.enum(['owners_identified', 'no_beneficial_owner']),
      owners: z
        .array(
          z
            .object({
              party_id: PARTY_ID,
              extent: z.string().trim().max(500).nullish().describe('Nature and extent of the interest; default from the aktiebok.'),
              control: z.enum(BO_CONTROL_KINDS).nullish(),
            })
            .strict(),
        )
        .max(50),
      basis: z.string().trim().max(2000).nullish().describe('What the assessment rests on; default "Aktieboken per <date>".'),
      family_aggregation_checked: z.boolean().describe('Close family holdings were counted together (LRVH 1:5).'),
      family_note: z.string().trim().max(2000).nullish(),
      control_agreements: z.boolean().describe('Control by agreement or board appointment rights exists (LRVH 1:3-4).'),
      control_note: z.string().trim().max(2000).nullish(),
    })
    .strict(),
  output: z.object({
    beneficial_owner_assessment_id: z.string(),
    changed: z.boolean(),
    ended_role_ids: z.array(z.string()),
    added_role_ids: z.array(z.string()),
    deadline_source_key: z.string().nullable(),
    filing_url: z.string(),
  }),
  errorCodes: [...ADMIN_WRITE_CODES, 'BENEFICIAL_OWNER_INVALID', 'BOLAGET_PARTY_NOT_FOUND', 'BOLAGET_DATES_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/beneficial-owners/assessments' },
  mcp: {
    name: 'gnubok_confirm_beneficial_owners',
    title: 'Confirm Beneficial Owners',
    description: 'Stage the LRVH 2:1 record of who the verkliga huvudmän are (or that there is none). A changed set adds a deadline to file with Bolagsverket.',
    visibility: 'search',
    keywords: ['verklig huvudman', 'bekräfta verkliga huvudmän', 'lrvh', 'anmäla verklig huvudman'],
    stage: { pendingType: 'confirm_beneficial_owners', title: () => 'Verkliga huvudmän: utredning' },
  },
  run: (ctx, input, { dryRun }) => adminGated(ctx, () => confirmBeneficialOwners(ctx, input, { dryRun })),
})

export const BOLAGET_OPERATIONS = [
  shareRegisterGet,
  shareRegisterEventsList,
  shareRegisterEventsCreate,
  shareClassesCreate,
  shareClassesUpdate,
  companyRolesList,
  companyRolesCreate,
  companyRolesEnd,
  signatoryRulesSet,
  beneficialOwnersGet,
  beneficialOwnersConfirm,
] as const
