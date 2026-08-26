'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createCompanyFromOnboarding } from '@/lib/company/actions'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { deriveFirstYearDefaults } from '@/lib/company/first-year-defaults'
import { parseStartMonthDay } from '@/lib/company/first-year-defaults'
import { fetchCompanyLookup } from '@/lib/company-lookup/fetch-company-lookup'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useBranding } from '@/lib/branding/brand-context'
import posthog from 'posthog-js'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'
import {
  BRANCH_PROVIDERS,
  branchDestination,
  type BranchChoice,
} from '@/lib/onboarding-journey/branch'
import {
  initJourney,
  journeyReducer,
  stationOfStep,
  type JourneyState,
} from '@/lib/onboarding-journey/reducer'
import {
  abFirstYearEndOptions,
  efFirstYearEndOptions,
  type FirstYearEndOption,
} from '@/lib/onboarding-journey/fiscal-options'
import type { EntityType } from '@/types'
import JourneyOrb, { type OrbState } from './JourneyOrb'
import JourneyTrack from './JourneyTrack'
import Question from './Question'
import ChipRow from './ChipRow'
import YearBand from './YearBand'
import JourneyDatePicker from './JourneyDatePicker'
import AddressFields from './AddressFields'
import { InkText } from './ink'
import './journey.css'

/**
 * The journey onboarding flow. Renders the reducer's current step,
 * performs the side effects, and collects the exact settings payload the
 * wizard sends today.
 *
 * TIC budget: fetchCompanyLookup fires exactly once per confirmed orgnr
 * (Enter, or the auto-submitted BankID deep link). No debounce-per-key,
 * no roster prefetch. The advisory dup check is an internal endpoint.
 */

const STATION_FRACS = [0.07, 0.285, 0.5, 0.715, 0.93]

const LOG = '[onboarding-journey]'
function logError(message: string, extra?: Record<string, unknown>) {
  console.error(LOG, message, extra ?? '')
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `onboarding-journey: ${message}`, extra }),
  }).catch(() => {})
}

/**
 * Branch-question funnel event. Anonymous by design: AnalyticsIdentify only
 * mounts in the dashboard layout, so this measures choice distribution, not
 * people. Guarded + swallowed like every product capture.
 */
function captureBranch(choice: BranchChoice) {
  if (!isAnalyticsEnabled()) return
  try {
    posthog.capture('onboarding_branch_chosen', { choice })
  } catch {
    // Telemetry must never affect the journey.
  }
}

interface OnboardingJourneyProps {
  teamId: string
  mode?: 'first' | 'add'
  initialOrgNumber?: string
  initialEntityType?: EntityType
  initialLegalName?: string
  /** A pending invitation exists for this user's email: an invitee has
   *  likely landed here by mistake (lost invite cookie), so the first
   *  question carries a "join via the link in the email" hint. */
  hasPendingInvite?: boolean
}

export default function OnboardingJourney({
  teamId,
  mode = 'first',
  initialOrgNumber,
  initialEntityType,
  initialLegalName,
  hasPendingInvite = false,
}: OnboardingJourneyProps) {
  const router = useRouter()
  const t = useTranslations('onboarding')
  const { appName } = useBranding()
  const locale = useLocale()
  const ticEnabled = ENABLED_EXTENSION_IDS.has('tic')

  const [state, dispatch] = useReducer(
    journeyReducer,
    { mode, initialOrgNumber, initialEntityType, initialLegalName },
    initJourney,
  )

  const bandRef = useRef<HTMLDivElement | null>(null)
  // Latches after the first done-screen branch choice (see onBranch below).
  const branchChosenRef = useRef(false)
  const [orgInput, setOrgInput] = useState(initialOrgNumber ?? '')
  const [orgShake, setOrgShake] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [narration, setNarration] = useState<string | null>(null)
  const [monogram, setMonogram] = useState<string | null>(null)
  const [dupName, setDupName] = useState<string | null>(null)
  const [dupElsewhere, setDupElsewhere] = useState(false)

  const station = stationOfStep(state.step)
  const entity = state.settings.entity_type
  const isEf = entity === 'enskild_firma'

  const monthLong = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'sv', { month: 'long' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 1)))
  }, [locale])
  const monthShort = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'sv', { month: 'short' })
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 1)).replace('.', ''))
  }, [locale])

  const formatDayMonthYear = useCallback(
    (isoDate: string) => {
      const [y, m, d] = isoDate.split('-').map(Number)
      return `${d} ${monthShort[(m ?? 1) - 1]} ${y}`
    },
    [monthShort],
  )

  /* ── side effects ─────────────────────────────────────────────── */

  // One lookup per confirmed orgnr: fired from the submit handler, never
  // from typing. The dup check (internal endpoint) rides along, advisory.
  const submitOrg = useCallback(
    (raw: string) => {
      const normalized = normalizeOrgNumber(raw)
      if (normalized === null) {
        setOrgShake(true)
        window.setTimeout(() => setOrgShake(false), 400)
        return
      }
      setDupName(null)
      setDupElsewhere(false)
      dispatch({ type: 'ORG_SUBMITTED', orgNumber: raw })
      fetchCompanyLookup(raw, { ticEnabled }).then((outcome) => {
        dispatch({ type: 'LOOKUP_RESULT', outcome })
      })
      fetch(`/api/company/check-org-number?org_number=${encodeURIComponent(raw)}`)
        .then(async (res) => {
          if (!res.ok) return
          const { data } = await res.json()
          setDupName(data?.companies?.[0]?.name ?? null)
          setDupElsewhere(Boolean(data?.exists_elsewhere))
        })
        .catch(() => {})
    },
    [ticEnabled],
  )

  // BankID deep link: auto-submit the orgnr once on mount (the single
  // lookup replaces the wizard's preverified suppression, per the plan
  // addendum). Guarded against strict-mode double-invoke.
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current) return
    autoRan.current = true
    // At mount the reducer is always on the orgnr step.
    if (initialOrgNumber) submitOrg(initialOrgNumber)
  }, [initialOrgNumber, submitOrg])

  // One choice only: rapid clicks on different chips must not race two
  // PATCHes (last-write-wins could persist the wrong path after navigation).
  const onBranch = useCallback(
    (choice: BranchChoice) => {
      if (branchChosenRef.current) return
      branchChosenRef.current = true
      const dest = branchDestination(choice)
      if (dest.path) {
        // Fire-and-forget: the checklist path is a nicety, routing is
        // the point. A lost PATCH just leaves the Hem checklist
        // unpathed; it must never block or delay the navigation.
        fetch('/api/onboarding/state', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dest.path }),
          keepalive: true,
        }).catch(() => logError('branch path persist failed', { choice }))
      }
      captureBranch(choice)
      router.push(dest.href)
    },
    [router],
  )

  // A short thinking beat between questions.
  const prevStep = useRef(state.step)
  useEffect(() => {
    if (prevStep.current === state.step) return
    prevStep.current = state.step
    if (state.step === 'done' || state.step === 'source' || state.submitting) return
    setThinking(true)
    const timer = window.setTimeout(() => setThinking(false), 420)
    return () => window.clearTimeout(timer)
  }, [state.step, state.submitting])

  // The finale: validate the period, narrate the real server steps while
  // createCompanyFromOnboarding runs, then check + monogram.
  const submitRan = useRef(false)
  useEffect(() => {
    if (!state.submitting || submitRan.current) return
    submitRan.current = true

    const s = state
    const periodResult = computeFiscalPeriod(s.settings)
    if (periodResult.error) {
      logError('journey period validation failed', { error: periodResult.error })
      submitRan.current = false
      dispatch({ type: 'SUBMIT_FAILED', code: 'period_invalid' })
      return
    }

    const msgs = [
      t('journey_shaping_accounts'),
      t('journey_shaping_period', { name: periodResult.periodName }),
      s.settings.vat_registered ? t('journey_shaping_vat') : t('journey_shaping_deadlines'),
    ]
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timers: number[] = []
    msgs.forEach((m, i) => {
      timers.push(window.setTimeout(() => setNarration(m), reduced ? 0 : i * 850))
    })

    createCompanyFromOnboarding({
      teamId,
      settings: s.settings as Record<string, unknown>,
      fiscalPeriod: {
        startDate: periodResult.startStr,
        endDate: periodResult.endStr,
        name: periodResult.periodName,
      },
      ticLookup: s.ticLookup,
    })
      .then((result) => {
        timers.forEach((id) => window.clearTimeout(id))
        setNarration(null)
        submitRan.current = false
        if (result.error || !result.companyId) {
          logError('journey create company failed', { error: result.error })
          dispatch({
            type: 'SUBMIT_FAILED',
            code: result.error === 'org_number_invalid' ? 'org_number_invalid' : 'generic',
          })
          return
        }
        dispatch({ type: 'SUBMIT_SUCCEEDED' })
        const initial = (s.settings.company_name || 'A').trim().charAt(0).toUpperCase()
        window.setTimeout(() => setMonogram(initial), reduced ? 0 : 1600)
      })
      .catch((err) => {
        timers.forEach((id) => window.clearTimeout(id))
        setNarration(null)
        submitRan.current = false
        logError('journey create company threw', {
          error: err instanceof Error ? err.message : String(err),
        })
        dispatch({ type: 'SUBMIT_FAILED', code: 'generic' })
      })
  }, [state, t, teamId])

  /* ── derived display ──────────────────────────────────────────── */

  const orbState: OrbState = state.step === 'done' || state.step === 'source'
    ? 'check'
    : state.submitting
      ? narration === null
        ? 'working'
        : 'shaping'
      : state.lookupPending
        ? 'searching'
        : thinking
          ? 'thinking'
          : 'listening'

  const fyAnswer = useMemo(() => {
    const s = state.settings
    if (s.is_first_fiscal_year && s.first_year_start && s.first_year_end) {
      return t('journey_ans_first', {
        from: formatDayMonthYear(s.first_year_start),
        to: formatDayMonthYear(s.first_year_end),
      })
    }
    if (s.fiscal_year_start_month === undefined) return null
    if (s.fiscal_year_start_month === 1) return t('journey_ans_calendar')
    return t('journey_ans_broken', {
      from: monthShort[s.fiscal_year_start_month - 1],
      to: monthShort[(s.fiscal_year_start_month + 10) % 12],
    })
  }, [state.settings, t, monthShort, formatDayMonthYear])

  const momsAnswer = state.settings.vat_registered === false
    ? t('journey_ans_vat_none')
    : state.settings.moms_period
      ? t(`journey_ans_${state.settings.moms_period}`)
      : null

  const methodAnswer = state.settings.accounting_method
    ? state.settings.accounting_method === 'accrual'
      ? t('journey_method_accrual')
      : t('journey_method_cash')
    : null

  const stations = [
    { label: t('journey_station_company'), answer: station > 0 ? (state.settings.company_name ?? null) : null },
    { label: t('journey_station_fiscal'), answer: station > 1 ? fyAnswer : null },
    { label: t('journey_station_vat'), answer: station > 2 ? momsAnswer : null },
    { label: t('journey_station_method'), answer: station > 3 ? methodAnswer : null },
    { label: t('journey_station_done') },
  ]

  const lookupFacts = useMemo(() => {
    const lk = state.ticLookup
    if (!lk || station > 0) return []
    const facts: { text: string; warn?: boolean }[] = []
    if (entity) facts.push({ text: entity === 'aktiebolag' ? t('journey_form_ab') : t('journey_form_ef') })
    if (lk.address?.city) facts.push({ text: lk.address.city })
    if (lk.sniCodes[0]?.name) facts.push({ text: lk.sniCodes[0].name })
    if (lk.registration.fTax) facts.push({ text: 'F-skatt' })
    if (lk.registration.vat) facts.push({ text: t('journey_fact_vat') })
    if (lk.isCeased) facts.push({ text: t('journey_fact_ceased'), warn: true })
    return facts
  }, [state.ticLookup, station, entity, t])

  /* ── per-step question rendering ──────────────────────────────── */

  const flyProps = { flyTargetRef: bandRef, flyTargetFrac: STATION_FRACS[station] }

  function renderStep() {
    const s = state.settings
    switch (state.step) {
      case 'orgnr':
        return (
          <Question
            title={t('journey_orgnr_title')}
            sub={hasPendingInvite ? t('journey_pending_invite_note') : undefined}
            attn={
              state.serverError === 'org_number_invalid'
                ? t('journey_err_org_invalid')
                : state.lookupNote === 'error'
                  ? t('journey_lookup_error')
                  : undefined
            }
          >
            <div className={`jny-biginput${orgShake ? ' is-err' : ''}`} style={{ marginTop: 26 }}>
              <input
                value={orgInput}
                inputMode="numeric"
                placeholder="556677-8899"
                aria-label={t('step2_org_number_label')}
                autoComplete="off"
                autoFocus
                disabled={state.lookupPending}
                onChange={(e) => setOrgInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !state.lookupPending) submitOrg(orgInput)
                }}
              />
            </div>
            <p className="jny-enterhint">
              {t('journey_press')} <b>Enter</b>
            </p>
          </Question>
        )

      case 'notfound':
        return (
          <Question title={t('journey_notfound_title')} sub={t('journey_notfound_sub')}>
            <ChipRow
              options={[
                { key: 'continue', label: t('journey_notfound_continue') },
                { key: 'edit', label: t('journey_notfound_edit') },
              ]}
              onPick={(k) =>
                dispatch({ type: k === 'continue' ? 'NOTFOUND_CONTINUE' : 'NOTFOUND_EDIT' })
              }
              {...flyProps}
            />
          </Question>
        )

      case 'ceased':
        return (
          <Question title={t('journey_ceased_title')} sub={t('journey_ceased_sub')}>
            <ChipRow
              options={[
                { key: 'continue', label: t('journey_ceased_continue') },
                { key: 'edit', label: t('journey_notfound_edit') },
              ]}
              onPick={(k) =>
                dispatch({ type: k === 'continue' ? 'CEASED_CONTINUE' : 'CEASED_EDIT' })
              }
              {...flyProps}
            />
          </Question>
        )

      case 'form':
        return (
          <Question title={t('journey_form_title')} info={t('journey_form_info')}>
            <ChipRow
              options={[
                { key: 'aktiebolag', label: t('journey_form_ab') },
                { key: 'enskild_firma', label: t('journey_form_ef') },
              ]}
              onPick={(k) => dispatch({ type: 'ENTITY_PICKED', entityType: k as EntityType })}
              {...flyProps}
            />
          </Question>
        )

      case 'name': {
        const suggested = s.company_name ?? ''
        return (
          <Question
            title={isEf ? t('journey_name_ef_title') : t('journey_name_ab_title')}
            sub={isEf ? t('journey_name_ef_sub') : t('journey_name_ab_sub')}
          >
            <NameInput
              key={state.step + suggested}
              initial={suggested}
              placeholder={isEf ? t('journey_name_ef_placeholder') : t('journey_name_ab_placeholder')}
              hint={
                <>
                  {t('journey_press')} <b>Enter</b>
                </>
              }
              onSubmit={(name) => dispatch({ type: 'NAME_SUBMITTED', name })}
            />
          </Question>
        )
      }

      case 'address':
        return (
          <Question title={isEf ? t('journey_addr_ef_title') : t('journey_addr_ab_title')}>
            <AddressFields
              placeholders={{
                street: t('step2_street_address'),
                postalCode: t('step2_postal_code'),
                city: t('step2_city'),
              }}
              enterHint={
                <>
                  {t('journey_press')} <b>Enter</b>
                </>
              }
              skipLabel={t('journey_addr_skip')}
              onSubmit={(v) => dispatch({ type: 'ADDRESS_SUBMITTED', ...v })}
            />
          </Question>
        )

      case 'fskatt':
        return (
          <Question
            title={isEf ? t('journey_fskatt_ef_title') : t('journey_fskatt_ab_title')}
            info={t('journey_fskatt_info')}
          >
            <ChipRow
              options={[
                { key: 'yes', label: t('journey_yes') },
                { key: 'no', label: t('journey_fskatt_no') },
              ]}
              onPick={(k) => dispatch({ type: 'FSKATT_ANSWERED', fskatt: k === 'yes' })}
              {...flyProps}
            />
          </Question>
        )

      case 'fy': {
        if (isEf) {
          return (
            <Question
              title={t('journey_fy_ef_title')}
              sub={t('journey_fy_ef_sub')}
              info={t('journey_fy_ef_info')}
              attn={state.serverError === 'period_invalid' ? t('journey_err_period') : undefined}
            >
              <ChipRow
                options={[
                  { key: 'ongoing', label: t('journey_fy_ef_ongoing') },
                  { key: 'first', label: t('journey_fy_ef_new') },
                ]}
                onPick={(k) =>
                  dispatch({ type: k === 'ongoing' ? 'FY_CALENDAR_CONFIRMED' : 'FY_FIRST_SELECTED' })
                }
                {...flyProps}
              />
            </Question>
          )
        }
        const startMonth = state.lookupRan
          ? parseStartMonthDay(state.ticLookup?.fiscalYear?.startMonthDay)
          : null
        const firstYearSuggested = state.lookupRan
          ? deriveFirstYearDefaults(state.ticLookup?.registrationDate).isFirstFiscalYear
          : false
        const confirmMode = startMonth !== null
        const title = confirmMode ? t('journey_fy_confirm_title') : t('journey_fy_ask_title')
        const sub = confirmMode
          ? startMonth === 1
            ? t('journey_fy_confirm_sub_calendar')
            : t('journey_fy_confirm_sub_broken', {
                from: monthLong[startMonth - 1],
                to: monthLong[(startMonth + 10) % 12],
              })
          : t('journey_fy_ask_sub')
        return (
          <Question
            title={title}
            sub={sub}
            info={t('journey_fy_info')}
            attn={state.serverError === 'period_invalid' ? t('journey_err_period') : undefined}
          >
            <ChipRow
              options={[
                {
                  key: 'confirm',
                  label: confirmMode ? t('journey_fy_yes') : t('journey_fy_calendar'),
                },
                { key: 'other', label: t('journey_fy_other') },
                {
                  key: 'first',
                  label: t('journey_fy_first'),
                  rec: firstYearSuggested ? t('journey_suggested') : undefined,
                },
              ]}
              onPick={(k) => {
                if (k === 'other') dispatch({ type: 'FY_OTHER_SELECTED' })
                else if (k === 'first') dispatch({ type: 'FY_FIRST_SELECTED' })
                else if (confirmMode && startMonth !== null && startMonth !== 1)
                  dispatch({ type: 'FY_END_MONTH_PICKED', endMonth: startMonth === 1 ? 12 : startMonth - 1 })
                else dispatch({ type: 'FY_CALENDAR_CONFIRMED' })
              }}
              {...flyProps}
            />
          </Question>
        )
      }

      case 'fymonth':
        return (
          <FyMonthStep
            t={t}
            monthShort={monthShort}
            monthLong={monthLong}
            onUse={(m) => dispatch({ type: 'FY_END_MONTH_PICKED', endMonth: m })}
          />
        )

      case 'fystart': {
        const regDate = state.lookupRan ? state.ticLookup?.registrationDate : null
        const regIso = regDate
          ? new Date(regDate).toISOString().slice(0, 10)
          : null
        return (
          <Question
            title={isEf ? t('journey_fystart_ef_title') : t('journey_fystart_ab_title')}
            sub={
              regIso
                ? t('journey_fystart_reg_sub', { date: formatDayMonthYear(regIso) })
                : isEf
                  ? t('journey_fystart_ef_sub')
                  : t('journey_fystart_ab_sub')
            }
          >
            {regIso ? (
              <FyStartWithSuggestion
                regIso={regIso}
                regLabel={formatDayMonthYear(regIso)}
                otherLabel={t('journey_fystart_other')}
                onPick={(d) => dispatch({ type: 'FY_START_PICKED', date: d })}
                flyProps={flyProps}
              />
            ) : (
              <JourneyDatePicker
                years={[new Date().getFullYear() - 1, new Date().getFullYear()]}
                onPick={(d) => dispatch({ type: 'FY_START_PICKED', date: d })}
              />
            )}
          </Question>
        )
      }

      case 'fyend':
        return (
          <FyEndStep
            t={t}
            isEf={isEf}
            startDate={s.first_year_start ?? ''}
            monthShort={monthShort}
            formatDate={formatDayMonthYear}
            onPick={(o) => dispatch({ type: 'FY_END_PICKED', date: o.date })}
            flyProps={flyProps}
          />
        )

      case 'momsyn':
        return (
          <Question
            title={isEf ? t('journey_momsyn_ef_title') : t('journey_momsyn_ab_title')}
            info={t('journey_momsyn_info')}
          >
            <ChipRow
              options={[
                { key: 'yes', label: t('journey_yes') },
                { key: 'no', label: t('journey_no') },
              ]}
              onPick={(k) => dispatch({ type: 'VAT_ANSWERED', registered: k === 'yes' })}
              {...flyProps}
            />
          </Question>
        )

      case 'moms': {
        let info = t('journey_moms_info')
        if (s.vat_number) info += ' ' + t('journey_moms_info_vatnr', { vatNumber: s.vat_number })
        return (
          <Question
            title={isEf ? t('journey_moms_ef_title') : t('journey_moms_ab_title')}
            sub={state.lookupRan && state.ticLookup?.registration.vat ? t('journey_moms_sub_registered') : undefined}
            info={info}
          >
            <ChipRow
              options={[
                { key: 'quarterly', label: t('journey_moms_quarterly') },
                { key: 'monthly', label: t('journey_moms_monthly') },
                { key: 'yearly', label: t('journey_moms_yearly') },
              ]}
              onPick={(k) =>
                dispatch({ type: 'MOMS_PERIOD_PICKED', period: k as 'monthly' | 'quarterly' | 'yearly' })
              }
              {...flyProps}
            />
          </Question>
        )
      }

      case 'method':
        return (
          <Question
            title={isEf ? t('journey_method_ef_title') : t('journey_method_ab_title')}
            info={t('journey_method_info')}
            attn={state.serverError === 'generic' ? t('journey_err_generic') : undefined}
          >
            <ChipRow
              options={[
                { key: 'accrual', label: t('journey_method_accrual') },
                { key: 'cash', label: t('journey_method_cash') },
              ]}
              onPick={(k) => dispatch({ type: 'METHOD_PICKED', method: k as 'accrual' | 'cash' })}
              disabled={state.submitting}
              {...flyProps}
            />
          </Question>
        )

      case 'done':
        return (
          <DoneStep
            t={t}
            state={state}
            mode={mode}
            fyAnswer={fyAnswer}
            momsAnswer={momsAnswer}
            methodAnswer={methodAnswer}
            onOpen={() => router.push('/')}
            onContinue={() => dispatch({ type: 'DONE_CONTINUE' })}
          />
        )

      case 'source':
        return <SourceStep t={t} onBranch={onBranch} />
    }
  }

  /* ── composition ──────────────────────────────────────────────── */

  return (
    <div className="jny jny-fixed" style={{ ['--jny-dawn' as string]: String(station / 4) }}>
      <div className="jny-dawn" aria-hidden="true" />
      {mode === 'add' && state.step !== 'done' ? (
        <Link href="/" className="jny-btn-quiet jny-escape">
          &lsaquo; {t('journey_cancel_add', { appName })}
        </Link>
      ) : null}
      <div className="jny-center">
        <div ref={bandRef} style={{ width: '100%' }}>
          <JourneyTrack
            stations={stations}
            active={station}
            onJump={
              state.submitting
                ? undefined
                : (i) => dispatch({ type: 'STATION_JUMP', station: i as 0 | 1 | 2 | 3 })
            }
            orbLabel={t(`journey_orb_${orbState}`)}
          >
            <JourneyOrb state={orbState} targetX={STATION_FRACS[station]} morphChar={monogram} />
          </JourneyTrack>
        </div>

        <div className={`jny-facts${station > 0 && !narration ? ' is-gone' : ''}`} aria-live="polite">
          {narration ? (
            <div className="jny-factname">
              <InkText text={narration} step={40} />
            </div>
          ) : (
            <>
              <div className="jny-factname">
                {state.ticLookup && station === 0 ? (
                  <InkText text={state.ticLookup.companyName} step={90} />
                ) : null}
              </div>
              <div className="jny-factmeta">
                {lookupFacts.map((f, i) => (
                  <span
                    key={f.text}
                    className={`jny-f is-on${f.warn ? ' is-warn' : ''}`}
                    style={{ transitionDelay: `${i * 150}ms` }}
                  >
                    {i > 0 ? ' · ' : ''}
                    {f.text}
                  </span>
                ))}
                {dupName && station === 0 ? (
                  <span className="jny-f is-on" style={{ transitionDelay: `${lookupFacts.length * 150}ms` }}>
                    {lookupFacts.length > 0 ? ' · ' : ''}
                    {t('journey_dup_note', { name: dupName, appName })}
                  </span>
                ) : null}
                {!dupName && dupElsewhere && station === 0 ? (
                  // Cross-account duplicate (#1231): the same org number
                  // already exists under another Accounted account. Shown
                  // only when there is no own-account match, which is the
                  // more specific hint.
                  <span className="jny-f is-on is-warn" style={{ transitionDelay: `${lookupFacts.length * 150}ms` }}>
                    {lookupFacts.length > 0 ? ' · ' : ''}
                    {t('journey_dup_elsewhere_note', { appName })}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className="jny-qarea">{renderStep()}</div>

        <div className="jny-balance" aria-hidden="true" />
        <div className="jny-backrow">
          {state.history.length > 0 &&
          state.step !== 'done' &&
          state.step !== 'source' &&
          !state.submitting ? (
            <button type="button" className="jny-btn-quiet" onClick={() => dispatch({ type: 'BACK' })}>
              &lsaquo; {t('back')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ── small step components ─────────────────────────────────────── */

type TFn = ReturnType<typeof useTranslations<'onboarding'>>

function NameInput({
  initial,
  placeholder,
  hint,
  onSubmit,
}: {
  initial: string
  placeholder: string
  hint: React.ReactNode
  onSubmit: (name: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <div className="jny-biginput">
        <input
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) onSubmit(value)
          }}
        />
      </div>
      <p className="jny-enterhint">{hint}</p>
    </>
  )
}

function FyMonthStep({
  t,
  monthShort,
  monthLong,
  onUse,
}: {
  t: TFn
  monthShort: string[]
  monthLong: string[]
  onUse: (endMonth: number) => void
}) {
  const [sel, setSel] = useState(0)
  const [hover, setHover] = useState(0)
  const m = hover || sel
  const year0 = new Date().getFullYear()
  const span: [number, number] | null = m ? (m === 12 ? [0, 11] : [m, m + 11]) : null
  const label = m
    ? m === 12
      ? `1 ${monthLong[0]} – 31 ${monthLong[11]}`
      : `1 ${monthLong[m % 12]} – ${monthLong[m - 1]}`
    : ''
  return (
    <Question title={t('journey_fymonth_title')} sub={t('journey_fymonth_sub')} info={t('journey_fymonth_info')}>
      <YearBand
        cells={24}
        year0={year0}
        span={span}
        label={label}
        note={m ? (m === 12 ? t('journey_band_calendar_note') : t('journey_band_broken_note')) : undefined}
      />
      <div className="jny-mchips">
        {monthShort.map((name, i) => (
          <button
            key={name}
            type="button"
            className={`jny-mchip${sel === i + 1 ? ' is-sel' : ''}`}
            onMouseEnter={() => setHover(i + 1)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setSel(i + 1)}
          >
            {name}
          </button>
        ))}
      </div>
      {sel ? (
        <div className="jny-qactions">
          <button type="button" className="jny-btn" onClick={() => onUse(sel)}>
            {t('journey_fymonth_use')}
          </button>
        </div>
      ) : null}
    </Question>
  )
}

function FyStartWithSuggestion({
  regIso,
  regLabel,
  otherLabel,
  onPick,
  flyProps,
}: {
  regIso: string
  regLabel: string
  otherLabel: string
  onPick: (date: string) => void
  flyProps: { flyTargetRef: React.RefObject<HTMLDivElement | null>; flyTargetFrac: number }
}) {
  const [manual, setManual] = useState(false)
  if (manual) {
    return (
      <JourneyDatePicker
        years={[new Date().getFullYear() - 1, new Date().getFullYear()]}
        onPick={onPick}
      />
    )
  }
  return (
    <ChipRow
      options={[
        { key: 'reg', label: regLabel },
        { key: 'other', label: otherLabel },
      ]}
      onPick={(k) => {
        if (k === 'reg') onPick(regIso)
        else setManual(true)
      }}
      {...flyProps}
    />
  )
}

function FyEndStep({
  t,
  isEf,
  startDate,
  monthShort,
  formatDate,
  onPick,
  flyProps,
}: {
  t: TFn
  isEf: boolean
  startDate: string
  monthShort: string[]
  formatDate: (iso: string) => string
  onPick: (o: FirstYearEndOption) => void
  flyProps: { flyTargetRef: React.RefObject<HTMLDivElement | null>; flyTargetFrac: number }
}) {
  const [endMonth, setEndMonth] = useState(12)
  const [showMonths, setShowMonths] = useState(false)
  const [preview, setPreview] = useState<FirstYearEndOption | null>(null)
  const [sy, sm] = startDate.split('-').map(Number)
  const options = isEf
    ? efFirstYearEndOptions(sy, sm)
    : abFirstYearEndOptions(sy, sm, endMonth)
  const cells: 24 | 36 = sm - 1 + 19 > 24 ? 36 : 24
  const span: [number, number] | null = preview
    ? [sm - 1, (preview.year - sy) * 12 + preview.month - 1]
    : [sm - 1, sm - 1]
  return (
    <Question
      title={t('journey_fyend_title')}
      sub={t('journey_fyend_sub')}
      info={isEf ? t('journey_fyend_ef_info') : t('journey_fyend_ab_info')}
    >
      <YearBand
        cells={cells}
        year0={sy}
        span={span}
        label={
          preview
            ? `${formatDate(startDate)} – ${formatDate(preview.date)}`
            : t('journey_fyend_start_label', { date: formatDate(startDate) })
        }
        note={
          preview
            ? `${t('journey_fyend_months', { count: preview.months })}${
                preview.months > 12
                  ? ` · ${t('journey_fyend_extended')}`
                  : preview.months < 12
                    ? ` · ${t('journey_fyend_short')}`
                    : ''
              }`
            : options.length === 0
              ? t('journey_fyend_none')
              : ''
        }
      />
      <div className="jny-chips" style={{ marginTop: 20 }}>
        {options.map((o) => (
          <button
            key={o.date}
            type="button"
            className="jny-pick"
            onMouseEnter={() => setPreview(o)}
            onClick={() => onPick(o)}
          >
            {formatDate(o.date)}
            <span className="jny-rec">{t('journey_fyend_months', { count: o.months })}</span>
          </button>
        ))}
        {!isEf ? (
          <button type="button" className="jny-pick" onClick={() => setShowMonths(true)}>
            {t('journey_fyend_other_month')}
          </button>
        ) : null}
      </div>
      {showMonths ? (
        <div className="jny-mchips">
          {monthShort.map((name, i) => (
            <button
              key={name}
              type="button"
              className={`jny-mchip${endMonth === i + 1 ? ' is-sel' : ''}`}
              onClick={() => {
                setEndMonth(i + 1)
                setPreview(null)
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
      <span style={{ display: 'none' }}>{flyProps.flyTargetFrac}</span>
    </Question>
  )
}

function DoneStep({
  t,
  state,
  mode,
  fyAnswer,
  momsAnswer,
  methodAnswer,
  onOpen,
  onContinue,
}: {
  t: TFn
  state: JourneyState
  mode: 'first' | 'add'
  fyAnswer: string | null
  momsAnswer: string | null
  methodAnswer: string | null
  onOpen: () => void
  onContinue: () => void
}) {
  const { appName } = useBranding()
  const s = state.settings
  const shortName = (s.company_name ?? '').split(' ')[0] || ''
  const rows: [string, string][] = [
    [t('journey_card_form'), s.entity_type === 'aktiebolag' ? t('journey_form_ab') : t('journey_form_ef')],
  ]
  if (s.org_number) {
    rows.push([
      s.entity_type === 'enskild_firma' ? t('journey_card_persnr') : t('journey_card_orgnr'),
      s.org_number,
    ])
  }
  if (s.city) rows.push([t('journey_card_seat'), s.city])
  if (fyAnswer) rows.push([t('journey_card_fy'), fyAnswer])
  if (s.f_skatt !== undefined) {
    rows.push([t('journey_card_fskatt'), s.f_skatt ? t('journey_card_fskatt_yes') : t('journey_card_fskatt_pending')])
  }
  if (momsAnswer) rows.push([t('journey_card_vat'), momsAnswer])
  if (methodAnswer) rows.push([t('journey_card_method'), methodAnswer])

  const notes: string[] = []
  if (s.is_first_fiscal_year && s.first_year_start && s.first_year_end) {
    notes.push(t('journey_note_first_year', { start: s.first_year_start, end: s.first_year_end }))
  }
  if (s.f_skatt === false) notes.push(t('journey_note_fskatt'))
  if (s.vat_registered === false) notes.push(t('journey_note_vat_watch'))
  if (state.ticLookup?.isCeased) notes.push(t('journey_note_ceased'))

  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={t('journey_done_title', { name: shortName })} />
      </h1>
      <div className="jny-card">
        <div className="jny-card-eyebrow">{t('journey_card_eyebrow')}</div>
        <div className="jny-card-name">{s.company_name}</div>
        <dl>
          {rows.map(([k, v], i) => (
            <CardRow key={k} label={k} value={v} delay={250 + i * 140} />
          ))}
        </dl>
      </div>
      {notes.length > 0 ? (
        <div className="jny-notes">
          {notes.map((n, i) => (
            <NoteLine key={n} text={n} delay={1000 + i * 260} />
          ))}
        </div>
      ) : null}
      {mode === 'first' ? (
        <Reveal delay={notes.length > 0 ? 1400 + notes.length * 260 : 1200}>
          <div className="jny-qactions">
            <button type="button" className="jny-btn" onClick={onContinue}>
              {t('journey_done_continue')}
            </button>
          </div>
        </Reveal>
      ) : (
        <div className="jny-qactions">
          <button type="button" className="jny-btn" onClick={onOpen}>
            {t('journey_open_app', { appName })}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The branch question as its own step, sharing the Klart station with the
 * welcome screen (same station grammar as momsyn/moms under Momsen).
 * Providers and the SIE file share one grid of generously sized tiles; the
 * provider tiles carry the real logo on a small white mark (the LogoMark
 * grammar from NewUserChecklist), the text answers stay equal-weight tiles.
 */
function SourceStep({ t, onBranch }: { t: TFn; onBranch: (choice: BranchChoice) => void }) {
  return (
    <Question title={t('journey_done_source_title')} sub={t('journey_done_source_sub')}>
      <div className="jny-srcgrid">
        {BRANCH_PROVIDERS.map((p) => (
          <button key={p.id} type="button" className="jny-srcpick" onClick={() => onBranch(p.id)}>
            <span className="jny-srcmark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.logo} alt="" />
            </span>
            {p.name}
          </button>
        ))}
        <button type="button" className="jny-srcpick is-text" onClick={() => onBranch('sie')}>
          {t('journey_done_source_sie')}
        </button>
        <button type="button" className="jny-srcpick is-text is-span" onClick={() => onBranch('fresh')}>
          {t('journey_done_source_fresh')}
        </button>
      </div>
      <div className="jny-qactions">
        <button type="button" className="jny-btn-quiet" onClick={() => onBranch('skip')}>
          {t('journey_done_source_skip')}
        </button>
      </div>
    </Question>
  )
}

/** Delayed mount so the continue action enters (with the standard .jny-qstep
 *  rise) only after the profile card and notes have finished settling. */
function Reveal({ delay, children }: { delay: number; children: React.ReactNode }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => setOn(true), reduced ? 0 : delay)
    return () => window.clearTimeout(id)
  }, [delay])
  if (!on) return null
  return <div className="jny-qstep">{children}</div>
}

function CardRow({ label, value, delay }: { label: string; value: string; delay: number }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => setOn(true), reduced ? 0 : delay)
    return () => window.clearTimeout(id)
  }, [delay])
  return (
    <div className={`jny-card-row${on ? ' is-on' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function NoteLine({ text, delay }: { text: string; delay: number }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => setOn(true), reduced ? 0 : delay)
    return () => window.clearTimeout(id)
  }, [delay])
  return <div className={on ? 'is-on' : undefined}>{text}</div>
}
