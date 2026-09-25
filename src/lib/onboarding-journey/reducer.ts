import type { CompanySettings, EntityType, MomsPeriod } from '@/types'
import type {
  CompanyLookupResult,
  CompanySearchHit,
  CompanySuggestion,
  RegistryHint,
} from '@/lib/company-lookup/types'
import type {
  CompanyLookupOutcome,
  CompanySearchOutcome,
} from '@/lib/company-lookup/fetch-company-lookup'
import {
  mapEntityType,
  mapPlannedLegalForm,
  mapSetupEntityType,
} from '@/lib/company-lookup/entity-type-map'
import { isEntityType, isEntityTypeCreatable, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { deriveSwedishVatNumber } from '@/lib/vat/vat-number'

/**
 * Pure state machine for the journey onboarding. The component renders `step`,
 * dispatches actions, and performs the side effects (the single TIC lookup
 * via fetchCompanyLookup, the createCompanyFromOnboarding call); the reducer
 * owns every transition and every settings write.
 *
 * Invariants encoded here:
 * - `settings` accumulates the exact CompanySettings partial today's wizard
 *   sends to createCompanyFromOnboarding: nothing less.
 * - `lookupRan` is true only when TIC answered with data for the CURRENT
 *   orgnr. Facts (name/address/F-skatt/moms/räkenskapsår) may be presented
 *   as facts only then; otherwise they are asked as questions. BankID
 *   prefill without a successful lookup is the degraded ask-questions path.
 * - `vat_registered` is never silently defaulted: it is either lookup data
 *   (registration.vat === true) or an explicit answer (ML 17 kap 24 §).
 * - History stores each step's ENTRY snapshot, so Back rolls both answers
 *   and stations to how they were when the step began.
 */

export type JourneyStep =
  | 'orgnr'
  | 'notfound'
  | 'ceased'
  | 'planned'
  | 'form'
  | 'name'
  | 'address'
  | 'fskatt'
  | 'fy'
  | 'fymonth'
  | 'fystart'
  | 'fyend'
  | 'momsyn'
  | 'moms'
  | 'method'
  | 'done'

export type JourneyStation = 0 | 1 | 2 | 3 | 4

const STATION_OF: Record<JourneyStep, JourneyStation> = {
  orgnr: 0,
  notfound: 0,
  ceased: 0,
  planned: 0,
  form: 0,
  name: 0,
  address: 0,
  fskatt: 0,
  fy: 1,
  fymonth: 1,
  fystart: 1,
  fyend: 1,
  momsyn: 2,
  moms: 2,
  method: 3,
  done: 4,
}

export function stationOfStep(step: JourneyStep): JourneyStation {
  return STATION_OF[step]
}

export type JourneyServerError =
  | 'org_number_invalid'
  | 'period_invalid'
  | 'generic'
  | null

/** The slice of state a step's entry snapshot preserves for Back. */
interface JourneySnapshot {
  step: JourneyStep
  settings: Partial<CompanySettings>
  ticLookup: CompanyLookupResult | null
  lookupRan: boolean
  /**
   * The advisory note the step carries.
   * - `error`: the orgnr lookup failed; shown on the manual path it lands on.
   * - `nomatch`: a name search returned nothing; the user refines in place.
   * - `searcherror`: the name search itself failed. Distinct from `error`
   *   because the step cannot continue without an orgnr, so the note must
   *   ask for the number instead of promising a manual path.
   */
  lookupNote: 'none' | 'error' | 'nomatch' | 'searcherror'
  addressAsked: boolean
  /** EF only: the verksamhetsnamn question was explicitly answered. */
  nameConfirmedForEf: boolean
  /**
   * The registry named a form Accounted has scoped but cannot create yet (a
   * planned form's code, or a flagged-off EntityType): the picker becomes
   * a "stöds inte ännu" stop. Null when the registry named nothing of the
   * kind.
   */
  plannedForm: string | null
}

export interface JourneyState extends JourneySnapshot {
  /** Entry snapshot of the CURRENT step (what Back from a later step restores). */
  entry: JourneySnapshot
  history: JourneySnapshot[]
  /** Component fires the lookup while this is true; reducer set on ORG_SUBMITTED. */
  lookupPending: boolean
  /** Name-search hits awaiting a pick on the orgnr step; empty otherwise.
   *  Not snapshotted: leaving the step drops them, Back re-asks. */
  searchHits: CompanySearchHit[]
  /** BankID CompanyRoles prefill present (name/entity trusted without lookup). */
  viaPrefill: boolean
  mode: 'first' | 'add'
  submitting: boolean
  serverError: JourneyServerError
}

export interface JourneyInit {
  mode?: 'first' | 'add'
  /** ?org_number= deep link. The component auto-submits it on mount, which
   *  triggers the same single lookup as manual entry (2026-07-24 addendum:
   *  no preverified suppression in the journey). */
  initialOrgNumber?: string
  initialEntityType?: EntityType
  initialLegalName?: string
}

export type JourneyAction =
  | { type: 'RESTORE'; state: JourneyState }
  | { type: 'DRAFT_SETTINGS'; settings: Partial<CompanySettings> }
  | { type: 'ORG_SUBMITTED'; orgNumber: string }
  | { type: 'LOOKUP_RESULT'; outcome: CompanyLookupOutcome }
  | { type: 'SEARCH_SUBMITTED'; query: string }
  | { type: 'SEARCH_RESULT'; outcome: CompanySearchOutcome }
  | { type: 'SEARCH_HIT_PICKED'; hit: CompanySearchHit }
  | { type: 'SUGGESTION_PICKED'; suggestion: CompanySuggestion }
  | { type: 'NOTFOUND_CONTINUE' }
  | { type: 'NOTFOUND_EDIT' }
  | { type: 'CEASED_CONTINUE' }
  | { type: 'CEASED_EDIT' }
  | { type: 'PLANNED_CONTINUE' }
  | { type: 'PLANNED_EDIT' }
  | { type: 'ENTITY_PICKED'; entityType: EntityType }
  | { type: 'NAME_SUBMITTED'; name: string }
  | { type: 'ADDRESS_SUBMITTED'; addressLine1?: string; postalCode?: string; city?: string }
  | { type: 'FSKATT_ANSWERED'; fskatt: boolean }
  | { type: 'FY_CALENDAR_CONFIRMED' }
  | { type: 'FY_OTHER_SELECTED' }
  | { type: 'FY_FIRST_SELECTED' }
  | { type: 'FY_END_MONTH_PICKED'; endMonth: number }
  | { type: 'FY_START_PICKED'; date: string }
  | { type: 'FY_END_PICKED'; date: string }
  | { type: 'VAT_ANSWERED'; registered: boolean }
  | { type: 'MOMS_PERIOD_PICKED'; period: MomsPeriod }
  | { type: 'METHOD_PICKED'; method: 'accrual' | 'cash' }
  | { type: 'SUBMIT_SUCCEEDED' }
  | { type: 'SUBMIT_FAILED'; code: 'org_number_invalid' | 'period_invalid' | 'generic' }
  | { type: 'BACK' }
  | { type: 'STATION_JUMP'; station: 0 | 1 | 2 | 3 }

function snapshotOf(s: JourneySnapshot): JourneySnapshot {
  return {
    step: s.step,
    settings: s.settings,
    ticLookup: s.ticLookup,
    lookupRan: s.lookupRan,
    lookupNote: s.lookupNote,
    addressAsked: s.addressAsked,
    nameConfirmedForEf: s.nameConfirmedForEf,
    plannedForm: s.plannedForm,
  }
}

export function initJourney(init: JourneyInit = {}): JourneyState {
  const settings: Partial<CompanySettings> = {}
  if (init.initialOrgNumber) settings.org_number = init.initialOrgNumber
  if (init.initialEntityType) settings.entity_type = init.initialEntityType
  if (init.initialLegalName) settings.company_name = init.initialLegalName
  const base: JourneySnapshot = {
    step: 'orgnr',
    settings,
    ticLookup: null,
    lookupRan: false,
    lookupNote: 'none',
    addressAsked: false,
    nameConfirmedForEf: false,
    plannedForm: null,
  }
  return {
    ...base,
    entry: snapshotOf(base),
    history: [],
    lookupPending: false,
    searchHits: [],
    viaPrefill: Boolean(init.initialOrgNumber && (init.initialEntityType || init.initialLegalName)),
    mode: init.mode ?? 'first',
    submitting: false,
    serverError: null,
  }
}

/** Transition to `next`, pushing the current step's entry snapshot.
 *  `patch` wins over the defaults (a transition may carry a serverError). */
function go(state: JourneyState, next: JourneyStep, patch?: Partial<JourneyState>): JourneyState {
  const moved: JourneyState = {
    ...state,
    lookupPending: false,
    searchHits: [],
    serverError: null,
    ...patch,
    step: next,
    history: [...state.history, state.entry],
  }
  return { ...moved, entry: snapshotOf(moved) }
}

/** Update within the current step (no history push, entry unchanged). */
function stay(state: JourneyState, patch: Partial<JourneyState>): JourneyState {
  return { ...state, ...patch }
}

/**
 * The form the picker must stop on when the registry named one Accounted
 * cannot create yet: a planned form's code, or a known form whose creation
 * flag is off. Null when the registry named nothing, or a creatable form.
 */
function plannedFormFor(legalEntityType: string | null | undefined): string | null {
  const mapped = mapEntityType(legalEntityType)
  if (mapped) return isEntityTypeCreatable(mapped) ? null : mapped
  return mapPlannedLegalForm(legalEntityType)?.code ?? null
}

/** Where a company without a known form goes: the stop, or the picker. */
function pickerStep(state: JourneyState): JourneyStep {
  return state.plannedForm ? 'planned' : 'form'
}

/**
 * The Företaget station asks only what is still unknown, then hands over to
 * the fiscal-year station. Order: name → address → F-skatt.
 * - A company_name from the lookup (or BankID roles) skips the name
 *   question for every form: the orgnr answers it, Enter is the whole step
 *   (founder call 2026-09-11). A form whose org number is the owner's
 *   personnummer (enskild firma) has no registered name, so without lookup
 *   data it still names its verksamhet; the name stays editable in Settings.
 * - Address is asked only when the lookup did not provide one.
 * - F-skatt is asked whenever it is not lookup data.
 */
function nextCompanyStep(state: JourneyState): JourneyStep {
  const s = state.settings
  const nameIsFreelyChosen = isEntityType(s.entity_type) && usesPersonnummerAsOrgNumber(s.entity_type)
  const nameKnown =
    !nameIsFreelyChosen || state.lookupRan || state.viaPrefill
      ? Boolean(s.company_name)
      : Boolean(s.company_name) && state.nameConfirmedForEf === true
  if (!nameKnown) return 'name'
  if (!state.lookupRan && !state.addressAsked) return 'address'
  if (s.f_skatt === undefined) return 'fskatt'
  return 'fy'
}

/** After the fiscal-year station: skip the moms question only when the
 *  lookup POSITIVELY says the company is VAT registered. A negative or
 *  missing registration is always asked (never defaulted). */
function afterFiscalYear(state: JourneyState): JourneyState {
  if (state.lookupRan && state.ticLookup?.registration.vat === true) {
    const settings = {
      ...state.settings,
      vat_registered: true,
      vat_number: deriveSwedishVatNumber(state.settings.org_number),
    }
    return go(stay(state, { settings }), 'moms')
  }
  return go(state, 'momsyn')
}

/** Downstream answers invalidated by an entity-type change. */
function wipeDownstream(settings: Partial<CompanySettings>): Partial<CompanySettings> {
  const next = { ...settings }
  delete next.fiscal_year_start_month
  delete next.is_first_fiscal_year
  delete next.first_year_start
  delete next.first_year_end
  delete next.vat_registered
  delete next.vat_number
  delete next.moms_period
  delete next.accounting_method
  return next
}

function withOrgNumber(state: JourneyState, orgNumber: string): JourneyState {
  return stay(state, { settings: { ...state.settings, org_number: orgNumber } })
}

/**
 * The single "TIC answered with data" transition, shared by a typed orgnr,
 * a one-hit name search and a picked hit: facts become settings, the step
 * advances past whatever the lookup already answered.
 */
function applyLookupFound(state: JourneyState, lookup: CompanyLookupResult): JourneyState {
  // Only forms this deployment can create are prefilled; a flagged-off or
  // planned form is remembered so the journey stops on it instead of
  // failing at the create step or offering the nearest supported form.
  const mapped = mapSetupEntityType(lookup.legalEntityType)
  const settings: Partial<CompanySettings> = {
    ...state.settings,
    entity_type: mapped ?? state.settings.entity_type,
    company_name: lookup.companyName || state.settings.company_name,
    address_line1: lookup.address?.street ?? state.settings.address_line1,
    postal_code: lookup.address?.postalCode ?? state.settings.postal_code,
    city: lookup.address?.city ?? state.settings.city,
    f_skatt: lookup.registration.fTax,
  }
  const enriched = stay(state, {
    settings,
    ticLookup: lookup,
    lookupRan: true,
    lookupNote: 'none' as const,
    plannedForm: mapped ? null : plannedFormFor(lookup.legalEntityType),
  })
  if (lookup.isCeased) return go(enriched, 'ceased')
  if (!settings.entity_type) return go(enriched, pickerStep(enriched))
  return go(enriched, nextCompanyStep(enriched))
}

/**
 * The register answered where the provider missed (SCB, through the TIC
 * route): the form and the name are settled, an address is taken when SCB
 * has one, F-skatt only when SCB states it, and the journey skips the "not
 * found" stop. `lookupRan` stays false on purpose so that what SCB does not
 * know (moms, an address it lacks) is still asked.
 */
function applyRegistryHint(state: JourneyState, hint: RegistryHint): JourneyState {
  const mapped = mapSetupEntityType(hint.legalEntityType)
  const hasAddress = Boolean(hint.address?.street || hint.address?.postalCode || hint.address?.city)
  const settings: Partial<CompanySettings> = {
    ...state.settings,
    entity_type: mapped ?? state.settings.entity_type,
    company_name: hint.companyName || state.settings.company_name,
    address_line1: hint.address?.street ?? state.settings.address_line1,
    postal_code: hint.address?.postalCode ?? state.settings.postal_code,
    city: hint.address?.city ?? state.settings.city,
    ...(hint.registration.fTax === null ? {} : { f_skatt: hint.registration.fTax }),
  }
  const enriched = stay(state, {
    settings,
    lookupNote: 'none' as const,
    addressAsked: state.addressAsked || hasAddress,
    plannedForm: mapped ? null : plannedFormFor(hint.legalEntityType),
  })
  if (!settings.entity_type) return go(enriched, pickerStep(enriched))
  return go(enriched, nextCompanyStep(enriched))
}

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyState {
  switch (action.type) {
    case 'RESTORE':
      // Restoring a draft must never re-submit company creation or a lookup.
      return {
        ...action.state,
        settings: state.settings.org_number && state.settings.org_number === action.state.settings.org_number
          ? { ...action.state.settings, ...state.settings }
          : action.state.settings,
        submitting: false, lookupPending: false, searchHits: [], serverError: null,
      }
    case 'DRAFT_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.settings } }
    case 'ORG_SUBMITTED': {
      if (state.submitting) return state
      // Fresh orgnr invalidates any previous lookup facts.
      return stay(state, {
        settings: { ...state.settings, org_number: action.orgNumber },
        ticLookup: null,
        lookupRan: false,
        lookupNote: 'none',
        lookupPending: true,
        searchHits: [],
        serverError: null,
        plannedForm: null,
      })
    }

    case 'SEARCH_SUBMITTED': {
      if (state.submitting) return state
      // A name search has no orgnr yet: it arrives with the picked hit.
      return stay(state, {
        settings: { ...state.settings, org_number: undefined },
        ticLookup: null,
        lookupRan: false,
        lookupNote: 'none',
        lookupPending: true,
        searchHits: [],
        serverError: null,
        plannedForm: null,
      })
    }

    case 'LOOKUP_RESULT': {
      if (!state.lookupPending) return state
      const cleared = stay(state, { lookupPending: false })
      const outcome = action.outcome

      if (outcome.status === 'aborted') return cleared

      if (outcome.status === 'found') {
        return applyLookupFound(cleared, outcome.result)
      }

      if (outcome.status === 'not_found') {
        if (outcome.registry) return applyRegistryHint(cleared, outcome.registry)
        return go(cleared, 'notfound')
      }

      // disabled: silent manual path. error: manual path + advisory note.
      const noted = stay(cleared, {
        lookupNote: outcome.status === 'error' ? ('error' as const) : ('none' as const),
      })
      if (noted.settings.entity_type) {
        // BankID prefill (or re-run after entity known): degraded ask-
        // questions path; entity/name from CompanyRoles survive as prefill.
        return go(noted, nextCompanyStep(noted))
      }
      return go(noted, pickerStep(noted))
    }

    case 'SEARCH_RESULT': {
      if (!state.lookupPending) return state
      const cleared = stay(state, { lookupPending: false })
      const outcome = action.outcome

      if (outcome.status === 'aborted') return cleared

      if (outcome.status === 'found') {
        // One hit resolves exactly like a typed orgnr; several wait for a pick.
        if (outcome.hits.length === 1) {
          return applyLookupFound(withOrgNumber(cleared, outcome.hits[0].orgNumber), outcome.hits[0].result)
        }
        return stay(cleared, { searchHits: outcome.hits })
      }

      // Without an orgnr there is no "continue manually" path from here:
      // the user refines the query or types the number. Both misses and
      // failures stay on the step with an advisory note that says so; the
      // orgnr path's "fortsätt manuellt" note would promise an exit this
      // step does not have.
      return stay(cleared, {
        lookupNote: outcome.status === 'not_found' ? ('nomatch' as const) : ('searcherror' as const),
      })
    }

    case 'SEARCH_HIT_PICKED': {
      if (state.submitting || state.step !== 'orgnr') return state
      return applyLookupFound(withOrgNumber(state, action.hit.orgNumber), action.hit.result)
    }

    case 'SUGGESTION_PICKED': {
      // A search-as-you-type row (SCB) resolves to an orgnr the same way a
      // typed one does: the component fires the single TIC lookup next and
      // LOOKUP_RESULT decides the step. What SCB already knows (name, form)
      // is prefill for the degraded paths (TIC off, error, not found), and
      // TIC's answer overrides it when it comes. lookupRan stays false: SCB
      // says nothing about F-skatt, VAT or the fiscal year.
      if (state.submitting || state.step !== 'orgnr') return state
      const { suggestion } = action
      const mapped = mapSetupEntityType(suggestion.legalEntityType)
      return stay(state, {
        settings: {
          ...state.settings,
          org_number: suggestion.orgNumber,
          company_name: suggestion.name,
          entity_type: mapped ?? state.settings.entity_type,
        },
        ticLookup: null,
        lookupRan: false,
        lookupNote: 'none',
        lookupPending: true,
        searchHits: [],
        serverError: null,
        plannedForm: mapped ? null : plannedFormFor(suggestion.legalEntityType),
      })
    }

    case 'NOTFOUND_CONTINUE': {
      if (state.settings.entity_type) return go(state, nextCompanyStep(state))
      return go(state, pickerStep(state))
    }

    case 'NOTFOUND_EDIT':
    case 'CEASED_EDIT':
    case 'PLANNED_EDIT': {
      // Back to the orgnr question; the fresh submit re-runs the single lookup.
      // The abandoned number's name and form go with it (a picked SCB row or
      // a ceased lookup put them there); BankID's CompanyRoles prefill stays,
      // it was never about this number.
      return go(state, 'orgnr', {
        settings: {
          ...state.settings,
          org_number: undefined,
          ...(state.viaPrefill ? {} : { company_name: undefined, entity_type: undefined }),
        },
        ticLookup: null,
        lookupRan: false,
        lookupNote: 'none',
        plannedForm: null,
      })
    }

    case 'CEASED_CONTINUE': {
      // Proceed with the (ceased) lookup facts: same as wizard, which lets
      // the user continue after the inline warning.
      if (!state.settings.entity_type) return go(state, pickerStep(state))
      return go(state, nextCompanyStep(state))
    }

    case 'PLANNED_CONTINUE': {
      // The user read the stop and still wants the picker; the planned form
      // stays on the state so the picker can keep naming it.
      return go(state, 'form')
    }

    case 'ENTITY_PICKED': {
      const prev = state.settings.entity_type
      let settings: Partial<CompanySettings> = { ...state.settings, entity_type: action.entityType }
      let next = state
      if (prev && prev !== action.entityType) {
        // Same guard as the wizard's step-1 wipe, but broader per the plan:
        // a changed entity invalidates org/name and every downstream answer.
        settings = wipeDownstream({
          ...settings,
          org_number: undefined,
          company_name: undefined,
        })
        next = stay(state, { ticLookup: null, lookupRan: false, nameConfirmedForEf: false })
        return go(stay(next, { settings }), 'orgnr')
      }
      return go(stay(next, { settings }), nextCompanyStep(stay(next, { settings })))
    }

    case 'NAME_SUBMITTED': {
      const trimmed = action.name.trim()
      if (!trimmed) return state
      const patched = stay(state, {
        settings: { ...state.settings, company_name: trimmed },
        nameConfirmedForEf: true,
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'ADDRESS_SUBMITTED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          address_line1: action.addressLine1 || state.settings.address_line1,
          postal_code: action.postalCode || state.settings.postal_code,
          city: action.city || state.settings.city,
        },
        addressAsked: true,
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'FSKATT_ANSWERED': {
      const patched = stay(state, {
        settings: { ...state.settings, f_skatt: action.fskatt },
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'FY_CALENDAR_CONFIRMED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          fiscal_year_start_month: 1,
          is_first_fiscal_year: false,
          first_year_start: undefined,
          first_year_end: undefined,
        },
      })
      return afterFiscalYear(patched)
    }

    case 'FY_OTHER_SELECTED':
      return go(state, 'fymonth')

    case 'FY_FIRST_SELECTED':
      return go(state, 'fystart')

    case 'FY_END_MONTH_PICKED': {
      const m = action.endMonth
      if (!Number.isInteger(m) || m < 1 || m > 12) return state
      const patched = stay(state, {
        settings: {
          ...state.settings,
          fiscal_year_start_month: m === 12 ? 1 : m + 1,
          is_first_fiscal_year: false,
          first_year_start: undefined,
          first_year_end: undefined,
        },
      })
      return afterFiscalYear(patched)
    }

    case 'FY_START_PICKED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          is_first_fiscal_year: true,
          first_year_start: action.date,
        },
      })
      return go(patched, 'fyend')
    }

    case 'FY_END_PICKED': {
      const endMonth = Number(action.date.split('-')[1])
      const patched = stay(state, {
        settings: {
          ...state.settings,
          is_first_fiscal_year: true,
          first_year_end: action.date,
          // The ongoing fiscal year starts the month after the first year
          // ends: same derivation as the wizard's Step 3.
          fiscal_year_start_month:
            Number.isInteger(endMonth) && endMonth >= 1 && endMonth <= 12
              ? endMonth === 12
                ? 1
                : endMonth + 1
              : 1,
        },
      })
      return afterFiscalYear(patched)
    }

    case 'VAT_ANSWERED': {
      if (action.registered) {
        const patched = stay(state, {
          settings: {
            ...state.settings,
            vat_registered: true,
            vat_number: deriveSwedishVatNumber(state.settings.org_number),
          },
        })
        return go(patched, 'moms')
      }
      const patched = stay(state, {
        settings: {
          ...state.settings,
          vat_registered: false,
          vat_number: null,
          moms_period: null,
        },
      })
      return go(patched, 'method')
    }

    case 'MOMS_PERIOD_PICKED': {
      const patched = stay(state, {
        settings: { ...state.settings, moms_period: action.period },
      })
      return go(patched, 'method')
    }

    case 'METHOD_PICKED': {
      return stay(state, {
        settings: { ...state.settings, accounting_method: action.method },
        submitting: true,
        serverError: null,
      })
    }

    case 'SUBMIT_SUCCEEDED':
      return go(stay(state, { submitting: false }), 'done')

    case 'SUBMIT_FAILED': {
      const cleared = stay(state, { submitting: false })
      if (action.code === 'org_number_invalid') {
        // The server rejected the orgnr: travel back to the Företaget
        // station. Answers are kept; the fresh orgnr re-runs the lookup and
        // the flow walks forward again.
        return go(cleared, 'orgnr', {
          ticLookup: null,
          lookupRan: false,
          serverError: 'org_number_invalid',
        })
      }
      if (action.code === 'period_invalid') {
        return go(cleared, 'fy', { serverError: 'period_invalid' })
      }
      return stay(cleared, { serverError: 'generic' })
    }

    case 'BACK': {
      if (state.submitting || state.history.length === 0) return state
      const history = [...state.history]
      const snap = history.pop() as JourneySnapshot
      return {
        ...state,
        ...snap,
        entry: snap,
        history,
        lookupPending: false,
        submitting: false,
        serverError: null,
      }
    }

    case 'STATION_JUMP': {
      if (state.submitting) return state
      const target = action.station
      if (stationOfStep(state.step) <= target) return state
      const history = [...state.history]
      let snap: JourneySnapshot | null = null
      while (history.length > 0) {
        const top = history[history.length - 1]
        const st = stationOfStep(top.step)
        if (st > target) {
          history.pop()
          continue
        }
        if (st === target) {
          snap = history.pop() as JourneySnapshot
          // Rewind to the station's FIRST step, not its last.
          while (
            history.length > 0 &&
            stationOfStep(history[history.length - 1].step) === target
          ) {
            snap = history.pop() as JourneySnapshot
          }
        }
        break
      }
      if (!snap) return state
      return {
        ...state,
        ...snap,
        entry: snap,
        history,
        lookupPending: false,
        submitting: false,
        serverError: null,
      }
    }

    default:
      return state
  }
}
