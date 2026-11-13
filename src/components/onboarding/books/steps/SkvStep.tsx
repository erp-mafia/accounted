'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BuildingLibraryIcon } from '@/components/icons'
import { useBranding } from '@/lib/branding/brand-context'
import { useFormat } from '@/lib/hooks/use-format'
import { useOAuthPopup } from '@/lib/hooks/use-oauth-popup'
import { isSkvPopupOrigin, type SkvPopupMessage } from '@/lib/skatteverket/popup-origin'
import { InkText } from '@/components/onboarding/journey/ink'
import { fmtKr } from '../engines/cash-draw'
import { SkvHandshake } from '../ui/SkvHandshake'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'
import { openOmbudDeepLink, verifyOmbudGrantWithRetries } from '@/components/skatteverket/ombud-appoint'
import type { ErrorLocale } from '@/lib/errors/get-error-message'

const RETURN_TO = '/onboarding/books?station=skv'
const AUTHORIZE_URL = `/api/extensions/ext/skatteverket/authorize?return_to=${encodeURIComponent(RETURN_TO)}`

/**
 * Anslut Skatteverket? The BankID button folds and leaves; the consent
 * runs in a new tab (the callback posts back and closes itself) while the
 * thread carries a light; on the message the rings meet, one ring closes
 * on the pair, the title inks and the tax account's own balance counts up
 * under the stamp with the next deadline beneath it. A blocked tab falls
 * back to the full-page flow: the return mounts straight into the back
 * phase from ?skv_connected=true.
 *
 * With system auth on (flags.skvOmbud) the button appoints the app as the
 * company's ombud instead: Skatteverket's e-service opens with the roles
 * pre-selected, the company signs there, and nothing calls back, so the
 * grant is checked against the ombudsregister when the user returns to
 * this page. One BankID signature then serves every later sync.
 */
export function SkvStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const tOmbud = useTranslations('skatteverket_ombud')
  const errorLocale = useLocale() as ErrorLocale
  const { appName } = useBranding()
  const { state, dispatch, flags, findings, loadFindings, landedError } = ctx
  const phase = state.skvPhase
  const [saldo, setSaldo] = useState<number | null>(null)
  const [attn, setAttn] = useState<string | null>(landedError)
  // Signed, but Skatteverket's register does not list the grant yet: a wait,
  // said in the same words as settings, Hem and the toasts, not an error.
  const [ombudWaiting, setOmbudWaiting] = useState(false)
  const timers = useRef<number[]>([])
  const watchRef = useRef<number | null>(null)
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  const ombudMode = Boolean(flags.skvOmbud)
  // Set once the ombud deep link is open: the next return to this page checks the register.
  const awaitingOmbud = useRef(false)
  // The register check in flight, with its waits when the server paces it: a
  // new signing, or leaving the step, drops it.
  const ombudCheck = useRef<AbortController | null>(null)
  useEffect(() => () => ombudCheck.current?.abort(), [])

  const at = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const stopWatch = useCallback(() => {
    if (watchRef.current) window.clearInterval(watchRef.current)
    watchRef.current = null
  }, [])

  useEffect(() => {
    const list = timers.current
    return () => {
      list.forEach((id) => window.clearTimeout(id))
      stopWatch()
    }
  }, [stopWatch])

  const arrive = useCallback(() => {
    stopWatch()
    dispatch({ type: 'SKV_PHASE', phase: 'back' })
    void loadFindings()
    fetch('/api/extensions/ext/skatteverket/skattekonto/saldo')
      .then(async (res) => {
        if (!res.ok) return
        const json = (await res.json()) as { data: { saldoSkatteverket: number } | null }
        if (json.data) setSaldo(json.data.saldoSkatteverket)
      })
      .catch(() => {})
    at(1500, () => dispatch({ type: 'SKV_PHASE', phase: 'done' }))
  }, [at, dispatch, loadFindings, stopWatch])

  // Mounted in the back phase: the full-page round trip brought us here.
  const mountedBack = useRef(phase === 'back')
  useEffect(() => {
    if (!mountedBack.current) return
    mountedBack.current = false
    const url = new URL(window.location.href)
    if (url.searchParams.has('skv_connected') || url.searchParams.has('skv_error')) {
      url.searchParams.delete('skv_connected')
      url.searchParams.delete('skv_error')
      window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : ''))
    }
    arrive()
  }, [arrive])

  // Already connected before this step opened (a reload): show the answer.
  useEffect(() => {
    if (phase === 'open' && findings?.skv.connected) {
      dispatch({ type: 'SKV_PHASE', phase: 'done' })
      fetch('/api/extensions/ext/skatteverket/skattekonto/saldo')
        .then(async (res) => {
          if (!res.ok) return
          const json = (await res.json()) as { data: { saldoSkatteverket: number } | null }
          if (json.data) setSaldo(json.data.saldoSkatteverket)
        })
        .catch(() => {})
    }
  }, [phase, findings?.skv.connected, dispatch])

  // The Skatteverket tab connect() opened: only its messages count. It stays
  // set after the tab closes, since the callback posts and then closes.
  const tabRef = useOAuthPopup<SkvPopupMessage>((data) => {
    if (data?.type === 'skatteverket-oauth-success') {
      if (phaseRef.current === 'leaving' || phaseRef.current === 'away') arrive()
    } else if (data?.type === 'skatteverket-oauth-error') {
      stopWatch()
      setAttn(t('skv_failed'))
      dispatch({ type: 'SKV_PHASE', phase: 'open' })
    }
  }, isSkvPopupOrigin)

  // Back from signing at Skatteverket: one register check per return.
  useEffect(() => {
    async function onVisible() {
      if (document.visibilityState !== 'visible' || !awaitingOmbud.current) return
      if (phaseRef.current !== 'leaving' && phaseRef.current !== 'away') return
      awaitingOmbud.current = false
      ombudCheck.current?.abort()
      const run = new AbortController()
      ombudCheck.current = run
      // Paced by the server (one check a minute): the step opens again and
      // says it checks again by itself, instead of asking for a new click.
      const outcome = await verifyOmbudGrantWithRetries(errorLocale, run.signal, (seconds) => {
        setAttn(t('skv_ombud_wait_retrying', { seconds }))
        dispatch({ type: 'SKV_PHASE', phase: 'open' })
      })
      if (!outcome) return
      ombudCheck.current = null
      if (outcome.result === 'granted') {
        setAttn(null)
        arrive()
        return
      }
      if (outcome.result === 'waiting') {
        setAttn(null)
        setOmbudWaiting(true)
      } else {
        setAttn(outcome.result === 'rate_limited' ? t('skv_ombud_wait') : (outcome.error ?? t('skv_failed')))
      }
      dispatch({ type: 'SKV_PHASE', phase: 'open' })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [arrive, dispatch, errorLocale, t])

  async function appointOmbud() {
    ombudCheck.current?.abort()
    ombudCheck.current = null
    setAttn(null)
    setOmbudWaiting(false)
    dispatch({ type: 'SKV_PHASE', phase: 'leaving' })
    at(900, () => {
      if (phaseRef.current === 'leaving') dispatch({ type: 'SKV_PHASE', phase: 'away' })
    })
    // Opens the tab inside this click, before its first await (popup blockers).
    const opened = await openOmbudDeepLink(errorLocale)
    if (!opened.ok) {
      setAttn(opened.error ?? t('skv_ombud_link_failed'))
      dispatch({ type: 'SKV_PHASE', phase: 'open' })
      return
    }
    // Already appointed (directly at Skatteverket, say): nothing to sign.
    if (opened.alreadyAppointed) {
      arrive()
      return
    }
    awaitingOmbud.current = true
  }

  function connect() {
    setAttn(null)
    // The tab must open inside the click, or the browser blocks it.
    const tab = window.open(AUTHORIZE_URL, '_blank')
    if (!tab) {
      // The authorize route is an API redirect, not a page: a hard navigation is the only way in.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = AUTHORIZE_URL
      return
    }
    tabRef.current = tab
    dispatch({ type: 'SKV_PHASE', phase: 'leaving' })
    at(900, () => {
      if (phaseRef.current === 'leaving') dispatch({ type: 'SKV_PHASE', phase: 'away' })
    })
    // Abandoned: the tab closed without a message.
    watchRef.current = window.setInterval(() => {
      if (tabRef.current && tabRef.current.closed) {
        stopWatch()
        at(600, () => {
          if (phaseRef.current === 'away' || phaseRef.current === 'leaving') {
            setAttn(t('skv_abandoned'))
            dispatch({ type: 'SKV_PHASE', phase: 'open' })
          }
        })
      }
    }, 1000)
  }

  const open = phase === 'open' || phase === 'leaving'
  const bodyCls = phase === 'leaving' ? ' is-away' : ''

  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={phase === 'done' ? t('skv_title_done') : t('skv_title')} />
      </h1>
      {open ? (
        <div className={`skv-body${bodyCls}`}>
          <p className="jny-qsub">
            {ombudWaiting
              ? tOmbud('waiting_hint', { appName })
              : ombudMode
                ? t('skv_ombud_sub', { appName })
                : t('skv_sub')}
          </p>
          {attn ? <p className="jny-attn">{attn}</p> : null}
          {flags.hasSkatteverket ? (
            <button
              type="button"
              className={`jny-bankid${phase === 'leaving' ? ' is-fold' : ''}`}
              onClick={ombudMode ? () => void appointOmbud() : connect}
            >
              <span className="pmark" aria-hidden="true">
                <BuildingLibraryIcon className="h-4 w-4" />
              </span>
              <span className="jny-bankid-txt">{ombudMode ? t('skv_ombud_connect', { appName }) : t('skv_connect')}</span>
            </button>
          ) : (
            <p className="jny-qsub">{t('skv_unavailable')}</p>
          )}
        </div>
      ) : null}
      {phase === 'away' || phase === 'back' || phase === 'done' ? (
        <SkvHandshake
          phase={phase}
          holdText={ombudMode ? t('skv_ombud_hold') : t('skv_hold')}
          leftLabel={appName}
          rightLabel={t('station_skv')}
        />
      ) : null}
      {phase === 'done' ? (
        <SkvSaldo
          saldo={saldo}
          ledger={findings?.skv.ledgerSkattekonto ?? null}
          account={findings?.skv.skattekontoAccount ?? '1630'}
          next={findings?.skv.nextDeadlines[0] ?? null}
        />
      ) : null}
      <div className="jny-qactions">
        {phase === 'done' ? (
          <Button size="lg" onClick={() => dispatch({ type: 'TO_DONE' })}>
            {t('to_done')}
          </Button>
        ) : open ? (
          <Button variant="ghost" size="sm" className={`text-muted-foreground${bodyCls}`} onClick={() => dispatch({ type: 'SKV_SKIP' })}>
            {t('skv_skip')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The success under the stamp, every line centred and unmarked: the tax
 * account's balance counting up (or, before the first fetch, one line that
 * it is on its way), how it sits against the skattekonto account (1630, or
 * 2012), the next deadline.
 */
function SkvSaldo({
  saldo,
  ledger,
  account,
  next,
}: {
  saldo: number | null
  ledger: number | null
  /** The skattekonto account the ledger figure is on: 1630, or 2012. */
  account: string
  next: { type: string; dueDate: string } | null
}) {
  const t = useTranslations('books')
  const { locale, formatDateLong } = useFormat()
  const shown = useCountUp(saldo ?? 0, 700)
  const differs = saldo !== null && ledger !== null && Math.abs(saldo - ledger) >= 1
  return (
    <div className="skv-result">
      {saldo !== null ? (
        <p className="saldo">
          <b>{fmtKr(shown, locale)}</b>
          <span>{t('skv_saldo_label')}</span>
        </p>
      ) : (
        <p className="skv-next">{t('v_skv_connected')}</p>
      )}
      {saldo !== null && ledger !== null ? (
        differs ? (
          <a href="/skattekonto" className="skv-line is-attn">{t('skv_diff_short', { ledger: fmtKr(ledger, locale), account })}</a>
        ) : (
          <p className="skv-line">{t('skv_reconciled_short')}</p>
        )
      ) : null}
      {next ? <p className="skv-next">{t('v_deadline', { type: t(`deadline_${next.type}`), date: formatDateLong(next.dueDate) })}</p> : null}
    </div>
  )
}

/** 0 to target over `ms` with an ease-out; lands at once under reduced motion. */
function useCountUp(target: number, ms: number): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    let raf = 0
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      raf = requestAnimationFrame(() => setValue(target))
      return () => cancelAnimationFrame(raf)
    }
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - p, 3)
      setValue(Math.round(target * e))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return value
}
