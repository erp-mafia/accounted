/**
 * Starting an aktiebolag from the founder's own AI (Claude, ChatGPT, Claude
 * Code): the MCP door to the same formation the /starta-bolag page runs on
 * (lib/formation). The interview happens in the chat with the start-company
 * skill; this one tool saves the answers, reports what is missing, records
 * the signed founding deed and, once Bolagsverket has registered the
 * company, sets it up after one approval.
 *
 * Personnummer never pass through the chat: the tool drops any it is sent
 * and points the founder to /starta-bolag, where each number is typed and
 * sealed. A formation belongs to a user and exists before its company, so
 * the tool is company-independent and needs no membership.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { lookupCompanyByOrgNumber } from '@/extensions/general/tic/lib/lookup'
import { TICAPIError } from '@/extensions/general/tic/lib/tic-types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { badArgument, codedRefusal } from '@/lib/errors/refusal'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'
import {
  type FormationAnswers,
  type FormationParty,
  boardMembers,
  deputies,
  formationAnswersSchema,
  persons,
  quotaValue,
} from '@/lib/formation/answers'
import { FORMATION_DOCUMENTS } from '@/lib/formation/documents'
import { rangeText, shareRanges } from '@/lib/formation/documents/facts'
import { signatoryRuleText } from '@/lib/formation/documents/signatory'
import { firstFiscalYear } from '@/lib/formation/fiscal-year'
import { shareholderAgreementEnabled } from '@/lib/formation/flags'
import { type FormationIssue, beneficialOwners, checkAnswers } from '@/lib/formation/rules'
import { checkSetupInput, runFormationSetup } from '@/lib/formation/setup'
import {
  type FormationRow,
  createFormation,
  currentFormation,
  isReady,
  markSubmitted,
  parseStoredAnswers,
  saveAnswers,
} from '@/lib/formation/store'
import type { ActorContext, McpTool, McpToolAnnotations } from './server'

const log = createLogger('mcp-formation')

export const FORMATION_TOOL = 'gnubok_formation'

const ACTIONS = ['save', 'status', 'submitted', 'setup'] as const
type Action = (typeof ACTIONS)[number]

export interface FormationToolDeps {
  annotations: McpToolAnnotations
  /** Absolute origin for links the founder opens in a browser. */
  appOrigin: () => string
  /**
   * The user's personal team, for a company created without a cookie session
   * (defaultTeamForNewCompany). Throws when it cannot be read, before the
   * company row is inserted, so the setup stops with nothing created.
   */
  defaultTeamForUser: (supabase: SupabaseClient, userId: string) => Promise<string | null>
  newCompanyReach: (
    supabase: SupabaseClient,
    userId: string,
    actor: ActorContext | undefined,
    companyId: string,
  ) => Promise<'default' | 'explicit' | 'unreachable'>
}

type IssueTexts = Record<string, string>

let issueTexts: Promise<IssueTexts> | null = null

/** The interview's own issue texts (formation.issues), in Swedish, so the chat says what the page says. */
function swedishIssueTexts(): Promise<IssueTexts> {
  issueTexts ??= import('@/messages/sv.json').then((mod) => {
    const messages = ((mod as { default?: unknown }).default ?? mod) as { formation: { issues: IssueTexts } }
    return messages.formation.issues
  })
  return issueTexts
}

/**
 * Fills a formation.issues text. Those texts use only {key} and {key, number}
 * (a test holds them to it), so the connector needs no message-format
 * library: next-intl cannot load outside Next under the react-server
 * condition, where scripts import this server.
 */
export function fillIssueText(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)(, number)?\}/g, (_, key: string) => {
    const value = params[key]
    return typeof value === 'number' ? new Intl.NumberFormat('sv-SE').format(value) : String(value ?? '')
  })
}

function normalisedName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The answers the chat sent, merged over what is stored: a top-level key the
 * chat sent replaces the stored one, a key it left out keeps the stored
 * value (the founder may have changed it on the page). A person keeps the
 * id it already has, matched by id or else by name, so a personnummer
 * sealed on the page survives the next save from the chat. Personnummer the
 * chat sent are dropped.
 */
export function mergeChatAnswers(raw: Record<string, unknown>, stored: FormationAnswers | null): { answers: FormationAnswers; droppedPersonnummer: boolean } {
  const parsed = formationAnswersSchema.safeParse({ ...(stored ?? {}), ...raw })
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'answers'}: ${issue.message}`).join('; ')
    throw badArgument('answers', `Invalid answers: ${detail}`)
  }
  const answers = parsed.data
  if (!('parties' in raw)) return { answers, droppedPersonnummer: false }

  const before = stored?.parties ?? []
  const byId = new Map(before.map((p) => [p.id, p]))
  const byName = new Map(before.filter((p) => p.type === 'person').map((p) => [normalisedName(p.name), p]))
  let dropped = false
  const parties: FormationParty[] = answers.parties.map((p) => {
    if (p.type !== 'person') return p
    if (p.personnummer.trim()) dropped = true
    const prior = byId.get(p.id) ?? byName.get(normalisedName(p.name))
    const { personnummerSealed: _sealed, personnummerLast4: _last4, ...rest } = p
    return { ...rest, id: prior && prior.type === 'person' ? prior.id : p.id, personnummer: '' }
  })
  return { answers: { ...answers, parties }, droppedPersonnummer: dropped }
}

/** Who still has to type a personnummer on the page. */
function personnummerStillNeeded(answers: FormationAnswers): string[] {
  return persons(answers)
    .filter((p) => (p.shares > 0 || p.roles.length > 0) && !p.personnummerLast4)
    .map((p) => p.name || 'okänt namn')
}

async function issueView(issues: FormationIssue[]) {
  const t = await swedishIssueTexts()
  return issues
    // Personnummer are the page's business: the chat names who is missing one instead.
    .filter((i) => !i.code.startsWith('personnummer_'))
    .map((i) => ({ step: i.step, field: i.field, code: i.code, severity: i.severity, message_sv: fillIssueText(t[i.code] ?? i.code, { name: t.unnamed ?? 'personen', ...(i.params ?? {}) }) }))
}

async function formationView(row: FormationRow, origin: string) {
  const answers = parseStoredAnswers(row.answers)
  const ready = isReady(row)
  const needsPersonnummer = personnummerStillNeeded(answers)
  return {
    formation_id: row.id,
    status: row.status,
    ready,
    issues: await issueView(checkAnswers(answers)),
    personnummer_needed_for: needsPersonnummer,
    beneficial_owners: beneficialOwners(answers),
    quota_value_kr: quotaValue(answers),
    deed_date: row.deed_date,
    company_id: row.company_id,
    page_url: `${origin}/starta-bolag`,
    documents: ready
      ? FORMATION_DOCUMENTS.filter((d) => d.available(answers) && (d.slug !== 'aktieagaravtal' || shareholderAgreementEnabled())).map((d) => d.slug)
      : [],
  }
}

function nextStep(view: Awaited<ReturnType<typeof formationView>>): string {
  if (view.status === 'set_up') return 'The company is set up in Accounted. Continue with the bookkeeping: bank connection and Skatteverket.'
  const errors = view.issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) return 'Ask the founder about each error in issues (one at a time, in their words), then save again.'
  if (view.personnummer_needed_for.length > 0)
    return `Send the founder to page_url: each person types their own personnummer there (${view.personnummer_needed_for.join(', ')}). Never ask for a personnummer in the chat. The documents open on the page once they are in.`
  if (view.status === 'submitted')
    return 'Wait for Bolagsverket (about 8 working days). When the registreringsbevis arrives, call again with action=setup and the organisation number.'
  return 'The documents are ready on page_url. Guide the bank step and verksamt.se with the answer sheet; when every founder has signed, call action=submitted with deed_date.'
}

async function setupPreview(answers: FormationAnswers, input: { orgNumber: string; companyName: string; registrationDate: string }) {
  const fy = firstFiscalYear(input.registrationDate, answers.fiscalYearStartMonth, answers.extendFirstYear)
  const role = (p: { roles: string[] }) => p.roles.join(', ')
  return {
    company_name: input.companyName,
    org_number: input.orgNumber,
    registration_date: input.registrationDate,
    first_fiscal_year: { start: fy.start, end: fy.end },
    share_capital_kr: answers.capital.amount,
    aktiebok: shareRanges(answers).map((r) => ({ name: r.party.name, shares: r.count, share_numbers: rangeText(r) })),
    board: persons(answers).filter((p) => p.roles.length > 0).map((p) => ({ name: p.name, roles: role(p) })),
    board_size: { members: boardMembers(answers).length, deputies: deputies(answers).length },
    signatory_rule: signatoryRuleText(answers.signatoryRule),
    auditor: answers.auditor.has ? answers.auditor.name : null,
    beneficial_owners: beneficialOwners(answers),
    voucher: `Aktiekapitalet, ${answers.capital.amount} kr, bokförs på registreringsdagen ${input.registrationDate}.`,
    documents_archived: ['bolagsordning', 'stiftelseurkund', 'styrelseprotokoll', 'aktiebok'],
  }
}

/** The registered company: the register's facts when it has them, else the founder's from the registreringsbevis. */
async function registeredCompany(
  args: Record<string, unknown>,
  orgNumber: string,
  subject: string,
): Promise<{ companyName: string | null; registrationDate: string | null; lookup: CompanyLookupResult | null; registry: 'found' | 'not_found' | 'unavailable' }> {
  let lookup: CompanyLookupResult | null = null
  let registry: 'found' | 'not_found' | 'unavailable' = 'not_found'
  try {
    lookup = await lookupCompanyByOrgNumber(orgNumber, { purpose: 'mcp_lookup', subject })
    registry = lookup ? 'found' : 'not_found'
  } catch (error) {
    if (!(error instanceof TICAPIError)) throw error
    registry = 'unavailable'
  }
  const typedName = typeof args.company_name === 'string' ? args.company_name.trim() : ''
  const typedDate = typeof args.registration_date === 'string' ? args.registration_date.trim() : ''
  if (typedDate && !isSaneDateString(typedDate)) throw badArgument('registration_date', 'registration_date must be YYYY-MM-DD')
  const registeredOn = lookup?.registrationDate ? new Date(lookup.registrationDate).toISOString().slice(0, 10) : null
  return {
    companyName: lookup?.companyName?.trim() || typedName || null,
    registrationDate: registeredOn ?? (typedDate || null),
    lookup,
    registry,
  }
}

export function createFormationTools(deps: FormationToolDeps): McpTool[] {
  return [
    {
      name: FORMATION_TOOL,
      keywords: ['starta bolag', 'starta aktiebolag', 'bolagsbildning', 'nytt aktiebolag', 'verksamt', 'stiftelseurkund', 'bolagsordning'],
      title: 'Start an Aktiebolag',
      description:
        'Start a new aktiebolag the founder is forming (load the start-company skill first). save stores the interview answers and lists what is missing; setup turns the formation into the company after registration: preview, then confirm=true.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          answers: { type: 'object', description: 'save: the sections you change, shaped as the skill says. No personnummer.' },
          deed_date: { type: 'string', description: 'submitted: day all founders signed' },
          org_number: { type: 'string' },
          company_name: { type: 'string' },
          registration_date: { type: 'string' },
          beneficial_owners_confirmed: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
        required: ['action'],
      },
      outputSchema: {
        type: 'object',
        properties: { formation_id: { type: 'string' }, ready: { type: 'boolean' }, preview: { type: 'object' }, company_id: { type: 'string' }, next: { type: 'string' } },
      },
      annotations: deps.annotations,
      async execute(args, _companyId, userId, supabase, actor) {
        const action = args.action as Action
        if (!ACTIONS.includes(action)) throw badArgument('action', `action must be one of ${ACTIONS.join(', ')}`)
        const origin = deps.appOrigin()
        const current = await currentFormation(supabase, userId)
        const open = current && current.status !== 'set_up' ? current : null

        if (action === 'status') {
          if (!current) return { formation: null, next: 'No formation yet. Interview the founder with the start-company skill, then call action=save.' }
          const view = await formationView(current, origin)
          return { ...view, next: nextStep(view) }
        }

        if (action === 'save') {
          if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)) throw badArgument('answers', 'save needs answers (an object)')
          const stored = open ? parseStoredAnswers(open.answers) : null
          const { answers, droppedPersonnummer } = mergeChatAnswers(args.answers as Record<string, unknown>, stored)
          const row = open ? await saveAnswers(supabase, userId, open.id, answers) : await createFormation(supabase, userId, answers)
          const view = await formationView(row, origin)
          return {
            ...view,
            ...(droppedPersonnummer ? { personnummer_note: 'Personnummer sent in the chat were not saved. Each person types theirs on page_url.' } : {}),
            next: nextStep(view),
          }
        }

        if (!open) {
          if (current?.status === 'set_up' && current.company_id) return { formation_id: current.id, company_id: current.company_id, next: 'The company is already set up in Accounted.' }
          throw codedRefusal('FORMATION_NOT_FOUND', 'There is no formation to continue: save the interview answers first.')
        }

        if (action === 'submitted') {
          const deedDate = typeof args.deed_date === 'string' ? args.deed_date.trim() : ''
          if (!isSaneDateString(deedDate) || deedDate > todayIsoStockholm()) {
            throw codedRefusal('FORMATION_DEED_DATE_INVALID', 'deed_date must be the YYYY-MM-DD day every founder signed, not in the future.')
          }
          const view = await formationView(await markSubmitted(supabase, userId, open.id, deedDate), origin)
          return { ...view, next: nextStep(view) }
        }

        // --- setup -------------------------------------------------------------
        const orgNumber = orgNumberKey(typeof args.org_number === 'string' ? args.org_number : '')
        if (!orgNumber) throw badArgument('org_number', 'setup needs the organisation number from the registreringsbevis (10 digits)')
        const answers = parseStoredAnswers(open.answers)
        if (!isReady(open)) {
          const view = await formationView(open, origin)
          return { ...view, next: `Not ready for setup. ${nextStep(view)}` }
        }
        const registered = await registeredCompany(args, orgNumber, actor?.id ?? userId)
        if (!registered.companyName || !registered.registrationDate) {
          return {
            formation_id: open.id,
            registry: registered.registry,
            next: 'The register has no data on this company yet. Ask the founder for the registered name and the registration date on the registreringsbevis, then call setup again with company_name and registration_date.',
          }
        }
        const today = todayIsoStockholm()
        const input = {
          orgNumber,
          companyName: registered.companyName,
          registrationDate: registered.registrationDate,
          beneficialOwnersConfirmed: args.beneficial_owners_confirmed === true,
          lookup: registered.lookup,
        }
        const refusal = checkSetupInput(input, open, today)
        if (refusal) throw codedRefusal(refusal, 'The organisation number or registration date does not fit this formation.')
        const preview = await setupPreview(answers, input)

        if (args.confirm !== true) {
          return {
            formation_id: open.id,
            requires_confirmation: true,
            preview,
            next: 'Nothing is set up yet. Read the preview back (name, first fiscal year, aktiebok, board, the share-capital voucher). Ask the founder to confirm the beneficial owners match what was reported to Bolagsverket. Then call setup again with confirm=true and beneficial_owners_confirmed=true.',
          }
        }
        if (!input.beneficialOwnersConfirmed) throw badArgument('beneficial_owners_confirmed', 'The founder confirms the beneficial owners before setup: pass beneficial_owners_confirmed=true.')

        const result = await runFormationSetup({
          supabase,
          service: supabase,
          userId,
          formationId: open.id,
          input,
          log,
          today,
          insertCompany: async (companyName) =>
            supabase.rpc('create_company_for_user', {
              p_user_id: userId,
              p_name: companyName,
              p_entity_type: 'aktiebolag',
              p_team_id: await deps.defaultTeamForUser(supabase, userId),
            }),
        })
        const reach = await deps.newCompanyReach(supabase, userId, actor, result.companyId)
        const connection =
          reach === 'default'
            ? 'This connection uses the new company from the next call.'
            : reach === 'explicit'
              ? `Pass company_id=${result.companyId} on calls for the new company: this connection's default company is unchanged.`
              : 'This connection does not reach the new company: the founder adds it under Agents > Connect an agent.'
        return {
          formation_id: open.id,
          company_id: result.companyId,
          created: true,
          preview,
          next: `${input.companyName} is set up in Accounted with a 30-day trial. ${connection} Next: Företagsregistrering at Skatteverket on verksamt.se (F-skatt, moms, arbetsgivare), then connect the bank.`,
        }
      },
    },
  ]
}

