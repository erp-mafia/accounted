'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import { useFormat } from '@/lib/hooks/use-format'
import { InkText } from '@/components/onboarding/journey/ink'
import { fmtKr } from '../engines/cash-draw'
import { SkvHandshake } from '../ui/SkvHandshake'
import type { BooksCtx } from '../context'

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
 */
export function SkvStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { appName } = useBranding()
  const { state, dispatch, flags, findings, loadFindings, landedError } = ctx
  const phase = state.skvPhase
  const [saldo, setSaldo] = useState<number | null>(null)
  const [attn, setAttn] = useState<string | null>(landedError)
  const timers = useRef<number[]>([])
  const tabRef = useRef<Window | null>(null)
  const watchRef = useRef<number | null>(null)
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const at = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const stopWatch = useCallback(() => {
    if (watchRef.current) window.clearInterval(watchRef.current)
    watchRef.current = null
    tabRef.current = null
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

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      const type = (event.data as { type?: string } | null)?.type
      if (type === 'skatteverket-oauth-success') {
        if (phaseRef.current === 'leaving' || phaseRef.current === 'away') arrive()
      } else if (type === 'skatteverket-oauth-error') {
        stopWatch()
        setAttn(t('skv_failed'))
        dispatch({ type: 'SKV_PHASE', phase: 'open' })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [arrive, dispatch, stopWatch, t])

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
          <p className="jny-qsub">{t('skv_sub')}</p>
          {attn ? <p className="jny-attn">{attn}</p> : null}
          {flags.hasSkatteverket ? (
            <button type="button" className={`jny-bankid${phase === 'leaving' ? ' is-fold' : ''}`} onClick={connect}>
              <span className="pmark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logos/skatteverket.svg" alt="" />
              </span>
              <span className="jny-bankid-txt">{t('skv_connect')}</span>
            </button>
          ) : (
            <p className="jny-qsub">{t('skv_unavailable')}</p>
          )}
        </div>
      ) : null}
      {phase === 'away' || phase === 'back' || phase === 'done' ? (
        <SkvHandshake phase={phase} holdText={t('skv_hold')} leftLabel={appName} rightLabel={t('station_skv')} />
      ) : null}
      {phase === 'done' ? (
        <SkvSaldo saldo={saldo} ledger={findings?.skv.ledger1630 ?? null} next={findings?.skv.nextDeadlines[0] ?? null} />
      ) : null}
      <div className="jny-qactions">
        {phase === 'done' ? (
          <button type="button" className="jny-btn" onClick={() => dispatch({ type: 'TO_DONE' })}>
            {t('to_done')}
          </button>
        ) : open ? (
          <button type="button" className={`jny-btn-quiet${bodyCls}`} onClick={() => dispatch({ type: 'SKV_SKIP' })}>
            {t('skv_skip')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The success under the stamp, every line centred and unmarked: the tax
 * account's balance counting up (or, before the first fetch, one line that
 * it is on its way), how it sits against 1630, the next deadline.
 */
function SkvSaldo({ saldo, ledger, next }: { saldo: number | null; ledger: number | null; next: { type: string; dueDate: string } | null }) {
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
          <a href="/skattekonto" className="skv-line is-attn">{t('skv_diff_short', { ledger: fmtKr(ledger, locale) })}</a>
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
