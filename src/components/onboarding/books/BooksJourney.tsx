'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { BooksFindings } from '@/lib/onboarding/findings'
import { singleFlight } from '@/lib/onboarding/single-flight'
import { useOnboardingNavigation } from '@/lib/hooks/use-onboarding-navigation'
import { useOnboardingStepEvent } from '@/lib/hooks/use-onboarding-step-event'
import { reconcileBooksDraft } from '@/lib/onboarding-books/resume'
import { booksSkip, skipShown } from '@/lib/onboarding-books/skip'
import { useBranding } from '@/lib/branding/brand-context'
import { useCompany } from '@/contexts/CompanyContext'
import { isLegalPersonOrgNumber } from '@/lib/invariants/org-number'
import { booksReducer, hasStepBehind, initialState, stationCount, stationOf, type BooksEntry, type BooksFlags } from '@/lib/onboarding-books/reducer'
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
import { AiStep } from './steps/AiStep'
import { DocsStep } from './steps/DocsStep'
import { DoneStep } from './steps/DoneStep'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

const STATION_FRACS = [0.07, 0.36, 0.64, 0.93]
const SOURCES_STATION_FRACS = [0.07, 0.242, 0.414, 0.586, 0.758, 0.93]

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
  /** See BooksFlags.skvOmbud. */
  skvOmbud?: boolean
  /** The arrangement with the AI and the receipts as steps of their own (lib/onboarding/sources-rollout). */
  sourcesFlow?: boolean
  /** This deployment receives from Kivra or Billo for the company (digitalMailboxAvailability). */
  hasMailboxes?: boolean
}

/**
 * Act two of the onboarding journey (issue #2438): Böckerna, Banken,
 * Skatteverket, Klart on the journey rail. The import, the bank round trip
 * and the Skatteverket consent happen inside this chrome, each ending on
 * a verdict computed from the company's own data. Bank and Skatteverket
 * are recommended, never mandatory. Leaving the act clears the
 * first-session gate and opens Hem. "Hoppa över tills vidare" leaves from
 * any step but Klart, also while an import runs (lib/onboarding-books/skip).
 * Tillbaka only ever goes one step back: the first step has none behind it
 * and shows no Tillbaka (hasStepBehind), it never opens the skip confirm.
 */
export default function BooksJourney(props: BooksJourneyProps) {
  const t = useTranslations('books')
  const router = useRouter()
  const { appName } = useBranding()
  const { company } = useCompany()
  const flags = useMemo<BooksFlags>(
    () => ({
      hasMigration: props.hasMigration,
      hasBanking: props.hasBanking,
      hasSkatteverket: props.hasSkatteverket,
      skvOmbud: props.skvOmbud ?? false,
      sourcesFlow: props.sourcesFlow ?? false,
      // Kivra and Billo hold a company mailbox only for a legal person's
      // number (lib/digital-mailboxes/connect.ts refuses the rest).
      hasDocs: (props.hasMailboxes ?? false) && isLegalPersonOrgNumber(company?.org_number),
    }),
    [props.hasMigration, props.hasBanking, props.hasSkatteverket, props.skvOmbud, props.sourcesFlow, props.hasMailboxes, company?.org_number],
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
  // The last findings read failed: the steps say so with a retry, never
  // "Inget importerat än", which is only true after a real answer.
  const [findingsFailed, setFindingsFailed] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState(false)
  const [skipOpen, setSkipOpen] = useState(false)
  // Read by the import loops mid-await, where the leaving state is stale.
  const leavingRef = useRef(false)
  const sourcesFlow = flags.sourcesFlow === true
  const station = stationOf(state.step, flags)
  const lastStation = stationCount(flags) - 1
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
          if (!res.ok) {
            setFindingsFailed(true)
            return null
          }
          const json = (await res.json()) as { data: BooksFindings }
          setFindings(json.data)
          setFindingsFailed(false)
          return json.data
        } catch {
          setFindingsFailed(true)
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

  useOnboardingStepEvent({
    journey: 'books',
    step: state.step === 'bank' && state.bankPhase === 'authed' ? 'bank-accounts' : state.step,
    ready: navigation.ready,
    path: state.path,
    provider: state.provider,
  })

  /* ── leaving the act ─────────────────────────────────────────────── */
  const leave = useCallback(
    async (outcome: 'done' | 'skipped', href = '/', hardNavigation = false) => {
      if (leaving) return
      setLeaving(true)
      leavingRef.current = true
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
        leavingRef.current = false
        return
      }
      clearDraft()
      if (hardNavigation) {
        window.location.assign(href)
        return
      }
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
    if (sourcesFlow) {
      const names = (findings?.ai.connected ?? []).map((id) => AI_CLIENTS.find((c) => c.id === id)?.name ?? id)
      const ai = names.length > 0 ? names.join(', ') : findings?.ai.agentConnected ? t('ai_agent') : t('answer_skipped')
      return [
        { label: t('station_books'), answer: station > 0 ? books : null },
        { label: t('station_bank'), answer: station > 1 ? bank : null },
        { label: t('station_ai'), answer: station > 2 ? ai : null },
        { label: t('station_docs') },
        { label: t('station_skv'), answer: station > 4 ? skv : null },
        { label: t('station_done') },
      ]
    }
    return [
      { label: t('station_books'), answer: station > 0 ? books : null },
      { label: t('station_bank'), answer: station > 1 ? bank : null },
      { label: t('station_skv'), answer: station > 2 ? skv : null },
      { label: t('station_done') },
    ]
  }, [findings, state.path, state.bankSkipped, state.skvSkipped, station, sourcesFlow, t])

  const skip = booksSkip(state, (findings?.books.entries ?? 0) > 0)

  const ctx: BooksCtx = {
    state,
    dispatch,
    flags,
    findings,
    loadingFindings,
    findingsFailed,
    loadFindings,
    landedError: props.landedError,
    isLeaving: () => leavingRef.current,
  }

  // Keep navigation in view, including during work when leaving is disabled.
  // The first step keeps the row's place and shows no Tillbaka: the skip
  // beside it stays where it is on every step.
  const backShown = hasStepBehind(state.step)
  const canGoBack =
    backShown &&
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
      case 'ai':
        return <AiStep ctx={ctx} />
      case 'docs':
        return <DocsStep ctx={ctx} />
      case 'skv':
        return <SkvStep ctx={ctx} />
      case 'done':
        return <DoneStep ctx={ctx} onLeave={(o, href) => void leave(o, href)} leaving={leaving} />
    }
  }

  return (
    <div className={sourcesFlow ? 'bks bks-six' : 'bks'} style={{ ['--jny-dawn' as string]: String(station / lastStation) }}>
      <div className="jny-dawn" aria-hidden="true" />
      <div className="bks-center">
        <JourneyTrack stations={stations} active={station} orbLabel={t(`orb_${orbState}`)}>
          <JourneyOrb state={orbState} targetX={(sourcesFlow ? SOURCES_STATION_FRACS : STATION_FRACS)[station]} />
        </JourneyTrack>
        <div className="bks-backrow">
          <Button variant="ghost" className={backShown ? 'text-muted-foreground' : 'invisible'} disabled={!canGoBack || !navigation.ready} onClick={() => navigation.back(() => navigation.stepBack(() => dispatch({ type: 'GO_BACK', flags })))}>
            ‹ {t('back')}
          </Button>
          {/* Never disabled by running work: an import is the server's job, so
              the act must not hold anyone (lib/onboarding-books/skip). */}
          {skipShown(state.step, sourcesFlow) && (
            <Button variant="ghost" className="bks-skip text-muted-foreground" disabled={leaving || !navigation.ready} onClick={() => setSkipOpen(true)}>
              {t('skip_all')}
            </Button>
          )}
        </div>
        <div className="bks-qarea" ref={areaRef} key={state.step}>
          {navigation.ready ? renderStep() : null}
          {leaveError && <p className="mt-4 text-center text-sm text-destructive" role="alert">{t('exit_failed')}</p>}
        </div>
      </div>
      <ConfirmDialog
        open={skipOpen}
        onOpenChange={setSkipOpen}
        title={t('skip_title')}
        description={
          skip.notice === 'running'
            ? t('skip_running')
            : skip.notice === 'resume'
              ? t('skip_resume')
              : skip.notice === 'empty'
                ? t('skip_all_cost', { appName })
                : undefined
        }
        confirmLabel={t('skip_all_confirm')}
        onConfirm={() => leave('skipped', skip.href, skip.hardNavigation)}
      />
    </div>
  )
}
