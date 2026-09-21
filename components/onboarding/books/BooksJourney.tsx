'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { BooksFindings } from '@/lib/onboarding/findings'
import { singleFlight } from '@/lib/onboarding/single-flight'
import { useOnboardingNavigation } from '@/lib/hooks/use-onboarding-navigation'
import { reconcileBooksDraft } from '@/lib/onboarding-books/resume'
import { booksReducer, initialState, stationOf, type BooksEntry, type BooksFlags } from '@/lib/onboarding-books/reducer'
import JourneyOrb, { type OrbState } from '@/components/onboarding/journey/JourneyOrb'
import JourneyTrack from '@/components/onboarding/journey/JourneyTrack'
import '@/components/onboarding/journey/journey.css'
import './books.css'
import type { BooksCtx } from './context'
import { SourceStep } from './steps/SourceStep'
import { SieStep } from './steps/SieStep'
import { ProviderStep } from './steps/ProviderStep'
import { ResumeStep } from './steps/ResumeStep'
import { InsightStep } from './steps/InsightStep'
import { BankStep } from './steps/BankStep'
import { SkvStep } from './steps/SkvStep'
import { DoneStep } from './steps/DoneStep'

const STATION_FRACS = [0.07, 0.36, 0.64, 0.93]

interface BooksJourneyProps {
  draftScope: string
  initialStation: string | null
  initialProvider: string | null
  /** The provider OAuth round trip landed here (the gate rewrote /import). */
  landedFromProvider: boolean
  /** The bank callback landed here with a connection waiting for its accounts. */
  selectAccounts: string | null
  /** The Skatteverket callback landed here. */
  skvConnected: boolean
  /** ?bank_error= or ?skv_error= text from a callback. */
  landedError: string | null
  /** See BooksEntry.resumeImportId / hasBooks: read server-side on every load. */
  resumeImportId: string | null
  hasBooks: boolean
  hasMigration: boolean
  hasBanking: boolean
  hasSkatteverket: boolean
}

/**
 * Act two of the onboarding journey (issue #2438): Böckerna, Banken,
 * Skatteverket, Klart on the journey rail. The import, the bank round trip
 * and the Skatteverket consent happen inside this chrome, each ending on
 * a verdict computed from the company's own data. Bank and Skatteverket
 * are recommended, never mandatory. Leaving the act clears the
 * first-session gate and opens Hem.
 */
export default function BooksJourney(props: BooksJourneyProps) {
  const t = useTranslations('books')
  const router = useRouter()
  const flags = useMemo<BooksFlags>(
    () => ({ hasMigration: props.hasMigration, hasBanking: props.hasBanking, hasSkatteverket: props.hasSkatteverket }),
    [props.hasMigration, props.hasBanking, props.hasSkatteverket],
  )
  const entry = useMemo<BooksEntry>(
    () => ({
      station: props.initialStation,
      provider: props.initialProvider,
      landedFromProvider: props.landedFromProvider,
      selectAccounts: props.selectAccounts,
      skvConnected: props.skvConnected,
      resumeImportId: props.resumeImportId,
      hasBooks: props.hasBooks,
    }),
    [props.initialStation, props.initialProvider, props.landedFromProvider, props.selectAccounts, props.skvConnected, props.resumeImportId, props.hasBooks],
  )
  const [state, dispatch] = useReducer(booksReducer, entry, initialState)
  const [findings, setFindings] = useState<BooksFindings | null>(null)
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState(false)
  const station = stationOf(state.step)
  const navigation = useOnboardingNavigation({
    scope: props.draftScope,
    step: state.step === 'bank' && state.bankPhase === 'authed' ? 'bank-accounts' : state.step,
    state,
    restore: (saved) => dispatch({ type: 'RESTORE', state: saved }),
    blocked: state.working || leaving,
    resetOnMount: !!(props.initialStation || props.landedFromProvider || props.selectAccounts || props.skvConnected || props.resumeImportId),
    reconcileDraft: (draft) => reconcileBooksDraft(draft, entry),
  })
  const clearDraft = navigation.clear

  /* ── findings: the verdict every station ends on ─────────────────── */
  // Single flight: a step change and the action that caused it both ask, and
  // the read scans the ledger. They share one request, and a trigger that
  // lands mid-request gets exactly one fresh read after it.
  const loadFindings = useMemo(
    () =>
      singleFlight(async () => {
        setLoadingFindings(true)
        try {
          const res = await fetch('/api/onboarding/findings')
          if (!res.ok) return null
          const json = (await res.json()) as { data: BooksFindings }
          setFindings(json.data)
          return json.data
        } catch {
          return null
        } finally {
          setLoadingFindings(false)
        }
      }),
    [],
  )

  useEffect(() => {
    if (navigation.ready && state.step !== 'sie' && state.step !== 'provider') void loadFindings()
  }, [navigation.ready, state.step, loadFindings])

  /* ── leaving the act ─────────────────────────────────────────────── */
  const leave = useCallback(
    async (outcome: 'done' | 'skipped', href = '/') => {
      if (leaving) return
      setLeaving(true)
      setLeaveError(false)
      try {
        const response = await fetch('/api/onboarding/books/exit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.path ? { outcome, path: state.path } : { outcome }),
        })
        if (!response.ok) throw new Error('Onboarding exit failed')
      } catch {
        setLeaveError(true)
        setLeaving(false)
        return
      }
      clearDraft()
      router.push(href)
      router.refresh()
    },
    [leaving, router, state.path, clearDraft],
  )

  /* ── focus follows the step: the new title is announced and reachable ─ */
  const areaRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const h1 = areaRef.current?.querySelector<HTMLElement>('h1')
    if (!h1) return
    h1.setAttribute('tabindex', '-1')
    h1.focus({ preventScroll: true })
  }, [state.step])

  /* ── derived ─────────────────────────────────────────────────────── */
  const orbState: OrbState = state.step === 'done' ? 'check' : state.working ? 'working' : 'listening'

  const stations = useMemo(() => {
    const books = findings && findings.books.entries > 0
      ? t('answer_entries', { count: findings.books.entries })
      : state.path === 'fresh'
        ? t('answer_fresh')
        : null
    const bank = findings?.bank.connected
      ? findings.bank.bankName ?? t('answer_connected')
      : state.bankSkipped
        ? t('answer_skipped')
        : null
    const skv = findings?.skv.connected ? t('answer_connected') : state.skvSkipped ? t('answer_skipped') : null
    return [
      { label: t('station_books'), answer: station > 0 ? books : null },
      { label: t('station_bank'), answer: station > 1 ? bank : null },
      { label: t('station_skv'), answer: station > 2 ? skv : null },
      { label: t('station_done') },
    ]
  }, [findings, state.path, state.bankSkipped, state.skvSkipped, station, t])

  const ctx: BooksCtx = { state, dispatch, flags, findings, loadingFindings, loadFindings, landedError: props.landedError }

  // Keep navigation in view, including during work when leaving is disabled.
  const canGoBack =
    !state.working &&
    !leaving &&
    !(state.step === 'bank' && (state.bankPhase === 'connecting' || state.bankPhase === 'fetching')) &&
    !(state.step === 'skv' && state.skvPhase === 'back')

  function renderStep() {
    switch (state.step) {
      case 'source':
        return <SourceStep ctx={ctx} />
      case 'sie':
        return <SieStep ctx={ctx} />
      case 'provider':
        return <ProviderStep ctx={ctx} />
      case 'resume':
        return <ResumeStep ctx={ctx} importId={props.resumeImportId ?? ''} />
      case 'insight':
        return <InsightStep ctx={ctx} />
      case 'bank':
        return <BankStep ctx={ctx} />
      case 'skv':
        return <SkvStep ctx={ctx} />
      case 'done':
        return <DoneStep ctx={ctx} onLeave={(o, href) => void leave(o, href)} leaving={leaving} />
    }
  }

  return (
    <div className="bks" style={{ ['--jny-dawn' as string]: String(station / 3) }}>
      <div className="jny-dawn" aria-hidden="true" />
      <div className="bks-center">
        <JourneyTrack stations={stations} active={station} orbLabel={t(`orb_${orbState}`)}>
          <JourneyOrb state={orbState} targetX={STATION_FRACS[station]} />
        </JourneyTrack>
        <div className="bks-backrow">
            <button type="button" className="jny-btn-quiet bks-back" disabled={!canGoBack || !navigation.ready} onClick={() => navigation.back(() => state.step === 'source' ? void leave('skipped') : dispatch({ type: 'GO_BACK', flags }))}>
              ‹ {t('back')}
            </button>
        </div>
        <div className="bks-qarea" ref={areaRef} key={state.step}>
          {navigation.ready ? renderStep() : null}
          {leaveError && <p className="mt-4 text-center text-sm text-destructive" role="alert">{t('exit_failed')}</p>}
        </div>
      </div>
    </div>
  )
}
