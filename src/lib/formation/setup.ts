/**
 * The one approval after registration: turn a formation into an Accounted
 * company, set up as the formation's answers say.
 *
 * Steps, in order, each recorded in `company_formations.setup_state` when
 * it has run, so a retry after a failure continues where it stopped and
 * never writes anything twice:
 *   company      the company, its first räkenskapsår from registration day,
 *                chart of accounts, settings (createCompanyCore, the path
 *                onboarding, MCP and v1 share)
 *   people       the register's people, with their personnummer sealed
 *   aktiebok     one 'bildande' entry per founder, dated the deed date
 *   roles        board, deputies, chair, VD, auditor from registration day
 *   signatory    the signatory rule (firmateckning)
 *   owners       the beneficial-owner assessment
 *   voucher      the share capital on registration day, booked as the
 *                repository's own share_capital_deposit template says
 *   documents    the founding documents archived as the company's documents
 * The Bolaget register writes go through the register services themselves
 * (lib/bolaget), the voucher through the capital posting path and the
 * engine, so every rule those enforce applies here too.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createCompanyCore } from '@/lib/company/create-company'
import { planCompanySetup } from '@/lib/company/onboarding-input'
import { setActiveCompany } from '@/lib/company/context'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { registerShareEvent } from '@/lib/bolaget/share-register'
import { addCompanyRole, setSignatoryRule } from '@/lib/bolaget/roles'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { ensureRegisterParty, savePersonPrivate } from '@/lib/bolaget/people'
import type { CompanyRoleKind } from '@/lib/bolaget/types'
import { postCapitalEntry } from '@/lib/bolaget/capital/postings'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { roundOre } from '@/lib/money'
import { codedRefusal } from '@/lib/errors/refusal'
import type { OperationContext } from '@/lib/operations/types'
import { type FormationAnswers, type FormationParty, type RoleKey, founders, primaryName, quotaValue } from './answers'
import { buildFormationDocument } from './documents'
import { signatoryRuleText } from './documents/signatory'
import { shareholderAgreementEnabled } from './flags'
import { firstFiscalYear } from './fiscal-year'
import { beneficialOwners, blockingIssues, isValidOrgNumber } from './rules'
import { type FormationRow, getFormation, openAnswers, parseStoredAnswers } from './store'

export interface SetupInput {
  orgNumber: string
  /** The registered name, as Bolagsverket registered it (one of the proposals, usually the first). */
  companyName: string
  /** ISO date Bolagsverket registered the company. */
  registrationDate: string
  /** The founders confirm the beneficial owners match what they reported. */
  beneficialOwnersConfirmed: boolean
  lookup?: CompanyLookupResult | null
}

export interface SetupState {
  companyId?: string
  parties?: Record<string, string>
  capitalSettings?: boolean
  aktiebok?: boolean
  roles?: boolean
  signatory?: boolean
  owners?: boolean
  voucher?: string
  documents?: Record<string, string>
}

export interface SetupResult {
  companyId: string
  state: SetupState
}

const ROLE_MAP: Record<RoleKey, CompanyRoleKind> = {
  ledamot: 'styrelseledamot',
  suppleant: 'styrelsesuppleant',
  ordforande: 'styrelseordforande',
  vd: 'vd',
}

/** The founding documents archived as the company's own documents. */
const ARCHIVED: readonly string[] = ['bolagsordning', 'stiftelseurkund', 'styrelseprotokoll', 'aktiebok', 'aktieagaravtal']

function isIsoDate(value: string): boolean {
  return isSaneDateString(value)
}

async function saveState(service: SupabaseClient, formation: FormationRow, state: SetupState, extra: Record<string, unknown> = {}) {
  const { error } = await service
    .from('company_formations')
    .update({ setup_state: state, ...extra })
    .eq('id', formation.id)
    .eq('user_id', formation.user_id)
  if (error) throw error
}

function unwrap<T>(outcome: { ok: true; data?: T } | { ok: false; code: string }, step: string): T {
  if (!outcome.ok) throw codedRefusal(outcome.code || 'FORMATION_SETUP_FAILED', `Formation setup step ${step} was refused: ${outcome.code}`)
  if (!('data' in outcome) || outcome.data === undefined) throw codedRefusal('FORMATION_SETUP_FAILED', `Formation setup step ${step} returned no data`)
  return outcome.data
}

/** The registered company the founders confirm, checked before anything is written. */
export function checkSetupInput(input: SetupInput, formation: FormationRow, today: string): string | null {
  if (!isValidOrgNumber(input.orgNumber)) return 'FORMATION_ORG_NUMBER_MISMATCH'
  // When the register answered, it must be an aktiebolag that is not ceased.
  const form = input.lookup?.legalEntityType?.toLowerCase() ?? null
  if (form && form !== 'ab' && !form.startsWith('aktiebolag')) return 'FORMATION_ORG_NUMBER_MISMATCH'
  if (input.lookup?.isCeased) return 'FORMATION_ORG_NUMBER_MISMATCH'
  if (!isIsoDate(input.registrationDate) || input.registrationDate > today) return 'FORMATION_ORG_NUMBER_MISMATCH'
  // Registered after the formation was started (a day's slack for time zones).
  const started = formation.created_at.slice(0, 10)
  const slack = new Date(Date.parse(`${started}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  if (input.registrationDate < slack) return 'FORMATION_ORG_NUMBER_MISMATCH'
  if (!input.companyName.trim()) return 'FORMATION_ORG_NUMBER_MISMATCH'
  return null
}

/**
 * Inserts the company row with the user as owner. The web door runs on the
 * cookie session (ensure_user_team + create_company_with_owner, both on
 * auth.uid()); the MCP door has no session and passes the service-role
 * create_company_for_user path that gnubok_create_company uses.
 */
export type InsertCompanyRow = (companyName: string) => PromiseLike<{ data: unknown; error: unknown }>

export async function runFormationSetup(args: {
  supabase: SupabaseClient
  service: SupabaseClient
  userId: string
  formationId: string
  input: SetupInput
  log: Logger
  today: string
  /** Set by a door without a cookie session; the company is then rolled back with `service`. */
  insertCompany?: InsertCompanyRow
}): Promise<SetupResult> {
  const { supabase, service, userId, log } = args
  const formation = await getFormation(service, userId, args.formationId)
  if (!formation) throw codedRefusal('FORMATION_NOT_FOUND', 'The company formation was not found.')
  if (formation.status === 'set_up' && formation.company_id) {
    return { companyId: formation.company_id, state: (formation.setup_state ?? {}) as SetupState }
  }
  const refusal = checkSetupInput(args.input, formation, args.today)
  if (refusal) throw codedRefusal(refusal, 'The organisation number or registration date does not fit this formation.')

  const answers: FormationAnswers = openAnswers(parseStoredAnswers(formation.answers))
  const blocking = blockingIssues(answers)
  if (blocking.length > 0) throw codedRefusal('FORMATION_INCOMPLETE', `Answers still break: ${blocking.map((i) => i.code).join(', ')}`)

  const reg = args.input.registrationDate
  const deedDate = formation.deed_date && formation.deed_date <= reg ? formation.deed_date : reg
  const state: SetupState = { ...((formation.setup_state ?? {}) as SetupState) }

  // --- company -------------------------------------------------------------
  if (!state.companyId) {
    const fy = firstFiscalYear(reg, answers.fiscalYearStartMonth, answers.extendFirstYear)
    const plan = planCompanySetup({
      name: args.input.companyName.trim(),
      entity_type: 'aktiebolag',
      org_number: orgNumberKey(args.input.orgNumber) ?? undefined,
      // Skatteverket registers VAT and F-skatt after Bolagsverket; the
      // company starts without either and the settings change when
      // Skatteverket's decision arrives.
      vat_registered: false,
      f_skatt: false,
      first_fiscal_year: { start: fy.start, end: fy.end },
      address_line1: answers.address.street || undefined,
      postal_code: answers.address.postalCode || undefined,
      city: answers.address.city || undefined,
    })
    if (!plan.ok) throw codedRefusal('FORMATION_SETUP_FAILED', plan.error)
    const insertCompany: InsertCompanyRow =
      args.insertCompany ??
      (async (companyName) => {
        const { data: teamId, error: teamError } = await supabase.rpc('ensure_user_team')
        if (teamError || !teamId) throw teamError ?? new Error('ensure_user_team returned no team')
        return supabase.rpc('create_company_with_owner', { p_name: companyName, p_entity_type: 'aktiebolag', p_team_id: teamId as string })
      })
    const created = await createCompanyCore(
      supabase,
      { ...plan.input, ticLookup: args.input.lookup ?? null },
      () => insertCompany(plan.input.companyName),
      args.insertCompany ? service : supabase,
    )
    if (created.error !== undefined) throw codedRefusal('FORMATION_SETUP_FAILED', created.error)
    state.companyId = created.companyId
    await saveState(service, formation, state, { company_id: created.companyId })
    try {
      await setActiveCompany(supabase, userId, created.companyId)
    } catch (err) {
      log.warn('formation.setup: setActiveCompany failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const companyId = state.companyId
  const ctx: OperationContext = { supabase, companyId, userId, log }

  // The Bolaget registers open for this company (lib/bolaget/gate.ts); the
  // rest of Bolaget stays on its own rollout.
  {
    const { error } = await service.from('companies').update({ bolaget_registers_enabled: true }).eq('id', companyId)
    if (error) throw error
  }
  // The share capital and share count the aktiebok is reconciled against
  // (lib/bolaget/reconcile.ts).
  if (!state.capitalSettings) {
    const written = await writeCompanySettings(ctx, { aktiekapital: answers.capital.amount, antal_aktier: answers.capital.shares })
    if (!written.ok) throw codedRefusal('FORMATION_SETUP_FAILED', `company_settings share capital was not written: ${written.code}`)
    state.capitalSettings = true
    await saveState(service, formation, state)
  }

  // --- people ---------------------------------------------------------------
  const involved = answers.parties.filter((p) => p.shares > 0 || (p.type === 'person' && p.roles.length > 0))
  if (!state.parties) state.parties = {}
  for (const party of involved) {
    if (state.parties[party.id]) continue
    const partyId = await ensureRegisterParty(ctx, {
      name: party.name,
      kind: party.type === 'company' ? 'company' : 'person',
      org_number: party.type === 'company' ? orgNumberKey(party.orgNumber) : null,
    })
    // The register keeps personnummer under the BankID key (lib/bolaget/people);
    // an installation without it still gets the register, and the founder adds
    // the numbers under Bolaget later.
    if (party.type === 'person' && party.personnummer && !process.env.BANKID_ENCRYPTION_KEY) {
      log.warn('formation.setup: BANKID_ENCRYPTION_KEY is not set, register people are saved without personnummer')
    } else if (party.type === 'person' && party.personnummer) {
      const saved = await savePersonPrivate(companyId, partyId, {
        personnummer: party.personnummer,
        email: party.email || undefined,
      })
      if (!saved.ok && saved.code !== 'BOLAGET_PERSONNUMMER_TAKEN') {
        throw codedRefusal(saved.code, `Saving the personnummer of a register person failed: ${saved.code}`)
      }
    }
    state.parties[party.id] = partyId
    await saveState(service, formation, state)
  }
  const partyOf = (p: FormationParty) => state.parties![p.id]

  // --- aktiebok ------------------------------------------------------------
  if (!state.aktiebok) {
    const quota = quotaValue(answers)
    for (const founder of founders(answers)) {
      unwrap(
        await registerShareEvent(
          ctx,
          {
            kind: 'bildande',
            event_date: deedDate,
            // No class named: the first issue in an empty register creates
            // class A (one vote a share), every later one uses that only class.
            to_party_id: partyOf(founder),
            share_count: founder.shares,
            price_total: roundOre(founder.shares * quota),
            registered_on: reg,
            note: 'Teckning vid bildandet',
            created_via: 'app',
          },
          { dryRun: false },
        ),
        'aktiebok',
      )
    }
    state.aktiebok = true
    await saveState(service, formation, state)
  }

  // --- roles ---------------------------------------------------------------
  if (!state.roles) {
    for (const person of answers.parties) {
      if (person.type !== 'person') continue
      for (const role of person.roles) {
        unwrap(
          await addCompanyRole(
            ctx,
            { party: { party_id: partyOf(person) }, role: ROLE_MAP[role], valid_from: reg, registered_at: reg, source: 'person' },
            { dryRun: false },
          ),
          'roles',
        )
      }
    }
    if (answers.auditor.has && answers.auditor.name) {
      const auditorId = await ensureRegisterParty(ctx, { name: answers.auditor.name, kind: 'person' })
      unwrap(
        await addCompanyRole(ctx, { party: { party_id: auditorId }, role: 'revisor', valid_from: reg, registered_at: reg, source: 'person' }, { dryRun: false }),
        'roles',
      )
    }
    state.roles = true
    await saveState(service, formation, state)
  }

  // --- signatory rule --------------------------------------------------------
  if (!state.signatory) {
    unwrap(
      await setSignatoryRule(ctx, { rule_text: signatoryRuleText(answers.signatoryRule), valid_from: reg, registered_at: reg, source: 'person' }, { dryRun: false }),
      'signatory',
    )
    state.signatory = true
    await saveState(service, formation, state)
  }

  // --- beneficial owners ------------------------------------------------------
  if (!state.owners) {
    const owners = beneficialOwners(answers)
    const rows: Array<{ party_id: string; extent: string; control: 'votes' | 'indirect' }> = []
    for (const owner of owners) {
      const direct = answers.parties.find((p) => p.type === 'person' && p.name === owner.name && p.shares > 0)
      const partyId = direct ? partyOf(direct) : await ensureRegisterParty(ctx, { name: owner.name, kind: 'person' })
      rows.push({ party_id: partyId, extent: `${String(owner.percent).replace('.', ',')} %`, control: owner.via === 'direct' ? 'votes' : 'indirect' })
    }
    const confirmed = unwrap(
      await confirmBeneficialOwners(
        ctx,
        {
          assessed_on: reg,
          conclusion: rows.length > 0 ? 'owners_identified' : 'no_beneficial_owner',
          owners: rows,
          basis: 'Aktieboken vid bildandet och uppgifterna i registreringsansökan',
          family_aggregation_checked: args.input.beneficialOwnersConfirmed,
          control_agreements: false,
        },
        { dryRun: false },
      ),
      'owners',
    )
    // For a cash formation the beneficial owners are reported in the same
    // verksamt.se filing as the company (lag 2017:631 2 kap. 3 §), so the
    // reminder the assessment files is already done: marked submitted on the
    // registration day, not left as a task.
    if (confirmed.deadline_source_key) {
      const { error } = await service
        .from('deadlines')
        .update({ is_completed: true, completed_at: `${reg}T12:00:00.000Z`, status: 'submitted', status_changed_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .eq('source_key', confirmed.deadline_source_key)
      if (error) log.warn('formation.setup: the beneficial-owner reminder was not marked done', { error: error.message })
    }
    state.owners = true
    await saveState(service, formation, state)
  }

  // --- share capital voucher ---------------------------------------------------
  if (!state.voucher) {
    const amount = roundOre(answers.capital.amount)
    // The repository's own definition of the entry (booking template share_capital_deposit).
    const template = getTemplateById('share_capital_deposit')
    if (!template?.debit_account || !template.credit_account) throw new Error('booking template share_capital_deposit is missing')
    const entry = await postCapitalEntry({
      supabase,
      companyId,
      userId,
      entryDate: reg,
      description: 'Aktiekapital vid bolagets bildande',
      lines: [
        { account_number: template.debit_account, debit_amount: amount, credit_amount: 0, line_description: 'Inbetalt aktiekapital' },
        { account_number: template.credit_account, debit_amount: 0, credit_amount: amount, line_description: 'Aktiekapital' },
      ],
      category: null,
    })
    state.voucher = entry.id
    await saveState(service, formation, state)
  }

  // --- founding documents -------------------------------------------------------
  if (!state.documents) state.documents = {}
  const docCtx = { today: args.today, deedDate, registration: { orgNumber: args.input.orgNumber, name: args.input.companyName.trim(), date: reg } }
  for (const slug of ARCHIVED) {
    if (state.documents[slug]) continue
    if (slug === 'aktieagaravtal' && !shareholderAgreementEnabled()) continue
    const doc = buildFormationDocument(slug, answers, docCtx)
    if (!doc) continue
    // Loaded here, not at the top: the MCP server imports this module, and the
    // PDF renderer is only needed for this one step.
    const { renderFormationPdf } = await import('./pdf')
    const pdf = await renderFormationPdf(doc)
    const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
    const uploaded = await uploadDocument(service, userId, companyId, { name: `${doc.slug}.pdf`, buffer, type: 'application/pdf' }, { upload_source: 'system', extractionOwner: 'none' })
    const documentId = (uploaded as { id: string }).id
    state.documents[slug] = documentId
    await saveState(service, formation, state)
  }

  await saveState(service, formation, state, { status: 'set_up', set_up_at: new Date().toISOString() })
  log.info('formation.setup: company set up', { formationId: formation.id, companyId, name: primaryName(answers) === args.input.companyName ? 'first proposal' : 'other name' })
  return { companyId, state }
}
