'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useAccounts, useCashAccounts, useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import type { CashAccount } from '@/types'
import { allocateLedgers, ledgerName, ledgerOptions } from '@/lib/onboarding-books/ledger'
import { LOOKBACK_SAFE_DAYS, resolveLookback, type LookbackMode } from '@/lib/onboarding-books/lookback'
import { biggestInflow, buildCashSeries, type CashPoint, type CashTx } from '@/lib/onboarding-books/cash-series'
import { toPickerAccounts, type PickerAccount, type StoredPickerAccount } from '@/lib/onboarding-books/picker-accounts'
import { InkText } from '@/components/onboarding/journey/ink'
import { fmtKr } from '../engines/cash-draw'
import { CashLine } from '../ui/CashLine'
import { initials, Pill, Pills } from '../ui/Pills'
import { OptRow, OptRows, Sentence } from '../ui/Sentence'
import { VerdictList, Wait, type Verdict } from '../ui/Verdicts'
import type { BooksCtx } from '../context'

const EB = '/api/extensions/ext/enable-banking'
const POPULAR = ['Swedbank', 'SEB', 'Nordea', 'Handelsbanken', 'Danske Bank', 'Länsförsäkringar', 'Skandiabanken', 'ICA Banken']
const PICK_COUNT = 6

interface Bank {
  name: string
  country: string
  logo?: string
}

interface SyncSummary {
  imported: number
  duplicates: number
  auto_matched?: number
  requested_from: string
  returned_min_date: string | null
  returned_max_date: string | null
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Koppla banken? Bank pills, the round trip, then the accounts as stacked
 * pills with nothing ticked, one sentence about ledger and start date with
 * Ändra behind it, and Hämta transaktioner: the ticked pills pour into the
 * cash line's origin, which pulses while the bank answers; the line then
 * grows over the fetched window while the caption counts the transactions.
 */
export function BankStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { locale, formatDateLong } = useFormat()
  const { state, dispatch, flags, findings, loadingFindings, loadFindings, landedError } = ctx
  const phase = state.bankPhase
  const isMig = state.path === 'migration' || (findings?.books.entries ?? 0) > 0
  const { cashAccounts, refresh: refreshCashAccounts } = useCashAccounts()
  const { accounts: chart } = useAccounts(true)
  const { periods } = useFiscalPeriods()
  const supabase = useMemo(() => createClient(), [])

  const [attn, setAttn] = useState<string | null>(landedError)
  const [banks, setBanks] = useState<Bank[] | null>(null)
  const [psuType, setPsuType] = useState<'personal' | 'business' | undefined>(undefined)
  const [more, setMore] = useState(false)
  const [query, setQuery] = useState('')

  const [accts, setAccts] = useState<PickerAccount[] | null>(null)
  const [ticked, setTicked] = useState<Record<string, boolean>>(state.bankDraft?.ticked ?? {})
  const [picks, setPicks] = useState<Record<string, string>>(state.bankDraft?.picks ?? {})
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<LookbackMode>(state.bankDraft?.mode ?? 'auto')
  const [customDate, setCustomDate] = useState(state.bankDraft?.customDate ?? '')

  useEffect(() => {
    dispatch({ type: 'BANK_DRAFT', draft: { ticked, picks, mode, customDate } })
  }, [ticked, picks, mode, customDate, dispatch])

  const [showCash, setShowCash] = useState(false)
  const [pillsGone, setPillsGone] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // A failed request must not let the delayed chart mount fire afterwards.
  const fetchingRef = useRef(false)
  const [points, setPoints] = useState<CashPoint[] | null>(null)
  const [inflow, setInflow] = useState<{ label: string; amount: number } | null>(null)
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [saldo, setSaldo] = useState(0)
  const [progress, setProgress] = useState(0)
  const [landed, setLanded] = useState(false)
  const timers = useRef<number[]>([])
  const at = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])
  useEffect(() => {
    const list = timers.current
    return () => list.forEach((id) => window.clearTimeout(id))
  }, [])

  /* ── pick: the bank list ─────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'pick' || banks || !flags.hasBanking) return
    let cancelled = false
    fetch(`${EB}/banks`)
      .then(async (res) => {
        const json = (await res.json()) as { banks?: Bank[]; psu_type?: 'personal' | 'business' }
        if (cancelled) return
        setBanks(json.banks ?? [])
        setPsuType(json.psu_type)
      })
      .catch(() => { if (!cancelled) setBanks([]) })
    return () => { cancelled = true }
  }, [phase, banks, flags.hasBanking])

  const orderedBanks = useMemo(() => {
    if (!banks) return []
    const rank = (b: Bank) => {
      const i = POPULAR.findIndex((p) => b.name.toLowerCase().startsWith(p.toLowerCase()))
      return i < 0 ? POPULAR.length : i
    }
    return [...banks].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'sv'))
  }, [banks])
  const shownBanks = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) return orderedBanks.filter((b) => b.name.toLowerCase().includes(q))
    return more ? orderedBanks : orderedBanks.slice(0, PICK_COUNT)
  }, [orderedBanks, more, query])

  // The bank's login runs in a popup, like the provider logins: the callback
  // page posts its outcome back and closes itself, so this page never
  // navigates. A blocked popup falls back to the full-page flow, which the
  // first-session gate carries back here with ?select_accounts=.
  const popupRef = useRef<Window | null>(null)
  const popupWatch = useRef<number | null>(null)
  // The popup posts and then closes: the close watcher must not undo an outcome that already arrived.
  const outcomeRef = useRef(false)
  const stopPopupWatch = useCallback(() => {
    if (popupWatch.current) window.clearInterval(popupWatch.current)
    popupWatch.current = null
    popupRef.current = null
  }, [])
  useEffect(() => stopPopupWatch, [stopPopupWatch])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: string; url?: string } | null
      if (data?.type !== 'enable-banking-connected' || typeof data.url !== 'string') return
      outcomeRef.current = true
      stopPopupWatch()
      let target: URL
      try { target = new URL(data.url, window.location.origin) } catch { return }
      const id = target.searchParams.get('select_accounts')
      const bankError = target.searchParams.get('bank_error')
      if (id) {
        dispatch({ type: 'BANK_AUTHED', name: state.bankName ?? '', connectionId: id })
      } else {
        setAttn(bankError || t('bank_connect_failed'))
        dispatch({ type: 'BANK_PICK_FAILED' })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [dispatch, state.bankName, stopPopupWatch, t])

  async function pickBank(b: Bank) {
    setAttn(null)
    dispatch({ type: 'BANK_PICKED', name: b.name })
    // The window must open inside the click, or the browser blocks it.
    const w = 520, h = 760
    const left = window.screenX + (window.outerWidth - w) / 2
    const top = window.screenY + (window.outerHeight - h) / 2
    const popup = window.open('', 'enable-banking', `width=${w},height=${h},left=${left},top=${top}`)
    popupRef.current = popup
    outcomeRef.current = false
    const body = { aspsp_name: b.name, aspsp_country: b.country, psu_type: psuType }
    try {
      let res = await fetch(`${EB}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.status === 409) {
        // A dead earlier row for the same bank: start fresh rather than stop here.
        res = await fetch(`${EB}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, force_new: true }) })
      }
      const json = (await res.json().catch(() => ({}))) as { authorization_url?: string; error?: unknown }
      if (!res.ok || !json.authorization_url) throw new Error(getErrorMessage(json, { locale: locale as 'sv' | 'en' }))
      // A deliberately closed popup cancels this attempt; only a blocked
      // popup should fall back to navigating the entire onboarding page.
      if (popup?.closed) {
        stopPopupWatch()
        dispatch({ type: 'BANK_PICK_FAILED' })
        return
      }
      if (popup && !popup.closed) {
        popup.location.href = json.authorization_url
        // Closed without an outcome: back to the pick, quietly.
        popupWatch.current = window.setInterval(() => {
          if (popupRef.current && popupRef.current.closed) {
            stopPopupWatch()
            at(500, () => { if (!outcomeRef.current) dispatch({ type: 'BANK_PICK_FAILED' }) })
          }
        }, 800)
      } else {
        window.location.assign(json.authorization_url)
      }
    } catch (err) {
      popup?.close()
      stopPopupWatch()
      setAttn(getErrorMessage(err, { locale: locale as 'sv' | 'en' }))
      dispatch({ type: 'BANK_PICK_FAILED' })
    }
  }

  /* ── authed: the accounts of the connection that came back ───────── */
  useEffect(() => {
    if (phase !== 'authed' || accts || !state.bankConnectionId) return
    let cancelled = false
    const url = new URL(window.location.href)
    if (url.searchParams.has('select_accounts') || url.searchParams.has('station')) {
      url.searchParams.delete('select_accounts')
      url.searchParams.delete('station')
      window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : ''))
    }
    void (async () => {
      const { data } = await supabase
        .from('bank_connections')
        .select('id, bank_name, status, accounts_data')
        .eq('id', state.bankConnectionId)
        .maybeSingle()
      if (cancelled) return
      const row = data as { id: string; bank_name: string | null; status: string; accounts_data: StoredPickerAccount[] | null } | null
      // Nothing to choose from is the bank's answer, not a state to sit in:
      // back to the bank list with the reason. An account another company
      // books is NOT that case: it is listed, named and left to the user.
      if (!row || !row.accounts_data || row.accounts_data.length === 0) {
        setAttn(t('bank_no_accounts'))
        dispatch({ type: 'BANK_PICK_FAILED' })
        return
      }
      if (row.bank_name && row.bank_name !== state.bankName) dispatch({ type: 'BANK_AUTHED', name: row.bank_name, connectionId: row.id })
      setAccts(toPickerAccounts(row.accounts_data, { account: t('bank_account'), otherCompany: t('bank_claimed_other_company') }))
    })()
    return () => { cancelled = true }
  }, [phase, accts, state.bankConnectionId, state.bankName, supabase, dispatch, t])

  const tickedList = useMemo(() => (accts ?? []).filter((a) => ticked[a.uid]), [accts, ticked])
  // The consequence line appears only once one of those accounts is actually
  // ticked: a notice, not a dialog, and nothing to dismiss.
  const tickedClaimed = useMemo(() => tickedList.filter((a) => a.claimedBy), [tickedList])
  const usedLedgers = useMemo(
    () => cashAccounts.filter((c) => c.bank_connection_id !== state.bankConnectionId).map((c) => c.ledger_account),
    [cashAccounts, state.bankConnectionId],
  )
  const ledgerOf = useMemo(() => {
    const preset: Record<string, string> = {}
    for (const a of tickedList) if (a.ledger) preset[a.uid] = a.ledger
    return allocateLedgers(tickedList, usedLedgers, { ...preset, ...picks })
  }, [tickedList, usedLedgers, picks])
  const chartNames = useMemo(() => Object.fromEntries(chart.map((a) => [a.account_number, a.account_name])), [chart])

  const today = isoToday()
  const fiscalYearStart = useMemo(() => {
    const cur = periods.find((p) => p.period_start <= today && p.period_end >= today)
    return cur?.period_start ?? periods[periods.length - 1]?.period_start ?? null
  }, [periods, today])
  const lookback = useMemo(
    () => resolveLookback({ mode, lastEntryDate: isMig ? findings?.books.lastEntryDate ?? null : null, fiscalYearStart, customDate: customDate || null, today }),
    [mode, isMig, findings?.books.lastEntryDate, fiscalYearStart, customDate, today],
  )
  const fromDefs = useMemo(() => {
    const defs: { mode: LookbackMode; label: string }[] = []
    if (isMig && findings?.books.lastEntryDate) {
      defs.push({ mode: 'auto', label: t('bank_from_opt_after', { date: formatDateLong(lookback.rule === 'after_last_entry' ? lookback.fromDate : findings?.books.lastEntryDate ?? today) }) })
      defs.push({ mode: '90', label: t('bank_from_opt_90') })
    } else {
      defs.push({ mode: 'auto', label: t('bank_from_opt_90') })
    }
    defs.push({ mode: 'fy', label: t('bank_from_opt_fy') })
    defs.push({ mode: 'date', label: t('bank_from_opt_date') })
    return defs
  }, [isMig, lookback.rule, lookback.fromDate, findings?.books.lastEntryDate, t, formatDateLong, today])

  /* ── fetch: the pour, the request, the line ──────────────────────── */
  async function fetchTransactions() {
    if (!state.bankConnectionId || tickedList.length === 0) return
    setAttn(null)
    setOpen(false)
    dispatch({ type: 'BANK_FETCH' })
    // What was on the page fades out in place; the chart fades in where it stood.
    fetchingRef.current = true
    at(400, () => { if (fetchingRef.current) { setPillsGone(true); setShowCash(true) } })
    const enabledUids = tickedList.map((a) => a.uid)
    try {
      // The accounts route refuses a 19xx that is not in the chart yet: create
      // the ones the sentence promised (named as the BAS chart names them).
      const known = new Set(chart.map((a) => a.account_number))
      const missing = enabledUids
        .map((uid) => ledgerOf[uid])
        .filter((l, i, arr) => l && !known.has(l) && arr.indexOf(l) === i)
      if (missing.length > 0) {
        const created = await fetch('/api/import/sie/create-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: missing.map((number) => ({ number, name: ledgerName(number, tickedList.find((a) => ledgerOf[a.uid] === number)?.currency ?? 'SEK', chartNames) })) }),
        })
        if (!created.ok) throw new Error(getErrorMessage(await created.json().catch(() => ({})), { locale: locale as 'sv' | 'en' }))
        void invalidateReferenceData('ref:accounts')
      }
      const res = await fetch(`${EB}/accounts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: state.bankConnectionId,
          enabled_uids: enabledUids,
          account_mappings: enabledUids.map((uid) => ({ uid, ledger_account: ledgerOf[uid] })),
          ...lookback.body,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { initial_sync?: SyncSummary; initial_sync_error?: string; error?: unknown }
      if (!res.ok) throw new Error(getErrorMessage(json, { locale: locale as 'sv' | 'en' }))
      notifyBankSyncUpdated()
      void invalidateReferenceData('ref:accounts')
      void loadFindings()
      const sum = json.initial_sync ?? { imported: 0, duplicates: 0, auto_matched: 0, requested_from: lookback.fromDate, returned_min_date: null, returned_max_date: null }
      setSummary(sum)
      if (json.initial_sync_error) setAttn(json.initial_sync_error)

      // Today's balance from the mirrored cash accounts, then the rows of the window.
      const [refreshedCashAccounts, txRes] = await Promise.all([
        refreshCashAccounts() as Promise<CashAccount[] | undefined>,
        fetch(`/api/transactions?date_from=${lookback.fromDate}&date_to=${today}`).then((r) => r.json()).catch(() => null) as Promise<{ data?: { date: string; amount: number; amount_sek?: number | null; description: string | null }[] } | null>,
      ])
      const mine = (refreshedCashAccounts ?? cashAccounts).filter((c) => c.bank_connection_id === state.bankConnectionId && c.external_uid && enabledUids.includes(c.external_uid))
      const balanceToday = mine.reduce((s, c) => s + (c.balance ?? 0), 0)
      const rows: CashTx[] = (txRes?.data ?? []).map((r) => ({ date: r.date, amount: typeof r.amount_sek === 'number' ? r.amount_sek : r.amount, description: r.description }))
      const series = buildCashSeries({ outflowFallbackLabel: t('bank_outflow'), transactions: rows, balanceToday, fromDate: sum.returned_min_date && sum.returned_min_date > lookback.fromDate ? sum.returned_min_date : lookback.fromDate, today })
      setInflow(biggestInflow(rows, t('bank_inflow')))
      setPoints(series.length >= 2 ? series : buildCashSeries({ outflowFallbackLabel: t('bank_outflow'), transactions: [], balanceToday, fromDate: lookback.fromDate, today }))
      dispatch({ type: 'BANK_CONNECTED' })
    } catch (err) {
      fetchingRef.current = false
      setAttn(getErrorMessage(err, { locale: locale as 'sv' | 'en' }))
      setShowCash(false)
      setPillsGone(false)
      if (state.bankConnectionId) dispatch({ type: 'BANK_AUTHED', name: state.bankName ?? '', connectionId: state.bankConnectionId })
    }
  }

  const onValue = useCallback((v: number, done: boolean, p: number) => {
    setSaldo(v)
    setProgress(p)
    if (done) setLanded(true)
  }, [])

  /* ── a reload after the bank was already connected ───────────────── */
  const alreadyConnected = phase === 'pick' && !!findings?.bank.connected
  const bankVerdicts = useMemo<Verdict[]>(() => {
    if (!findings?.bank.connected) return []
    const k = findings.bank
    const out: Verdict[] = [{ tone: 'ok', text: t('v_bank_connected', { bank: k.bankName ?? t('answer_connected'), count: k.transactions }) }]
    if (k.sweep) {
      out.push({ tone: 'ok', text: t('v_bank_matched', { count: k.sweep.auto_linked }) })
      if (k.sweep.unmatched + k.sweep.suggested > 0) out.push({ tone: 'warn', text: t('v_bank_review', { count: k.sweep.unmatched + k.sweep.suggested }), href: '/transactions' })
    }
    return out
  }, [findings, t])

  /* ── render ──────────────────────────────────────────────────────── */
  const title = phase === 'connected' || alreadyConnected
    ? t('bank_title_done')
    : phase === 'authed' || phase === 'fetching'
      ? t('bank_title_authed', { bank: state.bankName ?? '' })
      : t('bank_title')
  const txN = Math.round((summary?.imported ?? 0) * progress)
  const txM = Math.round((summary?.auto_matched ?? 0) * progress)
  const txR = Math.max(0, txN - txM)
  const nAcct = tickedList.length
  const gather = phase === 'fetching' || (phase === 'connected' && !pillsGone)

  return (
    <div className="bks-host">
      <div className="jny-qstep" style={{ textAlign: 'center' }}>
        <h1 className="jny-qtitle"><InkText text={title} /></h1>
        {phase === 'authed' ? <p className="jny-qsub">{t('bank_sub_authed')}</p> : null}
        {attn ? <p className="jny-attn" style={{ margin: '0 0 16px' }}>{attn}</p> : null}
      </div>

      {alreadyConnected ? <VerdictList verdicts={bankVerdicts} /> : null}

      {phase === 'pick' && !alreadyConnected ? (
        !findings ? (
          <div className="jny-qactions is-stack">
            {loadingFindings ? <Wait text={t('bank_loading')} height={96} /> : <button type="button" className="jny-btn-quiet" onClick={() => void loadFindings()}>{t('findings_retry')}</button>}
            <button type="button" className="jny-btn-quiet" onClick={() => dispatch({ type: 'BANK_SKIP', flags })}>{t('bank_manual')}</button>
          </div>
        ) : !flags.hasBanking ? (
          <p className="jny-qsub" style={{ textAlign: 'center' }}>{t('bank_unavailable')}</p>
        ) : banks === null ? (
          <Wait text={t('bank_loading')} height={96} />
        ) : (
          <>
            <div className="bank-search">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setMore(false) }} placeholder={t('bank_search')} aria-label={t('bank_search')} />
            </div>
            <div className="bank-picker-actions">
              {orderedBanks.length > PICK_COUNT || query ? (
                <button type="button" className="jny-btn-quiet" aria-expanded={more || !!query.trim()} aria-controls="onboarding-bank-list" onClick={() => { setMore(!more && !query.trim()); setQuery('') }}>
                  {more || query.trim() ? t('bank_less') : t('bank_more')}
                </button>
              ) : null}
            </div>
            <div id="onboarding-bank-list" className="bankgrid bank-list">
              {shownBanks.map((b, i) => (
                <Pill key={b.name} index={i} logo={b.logo} mark={b.logo ? undefined : initials(b.name)} onClick={() => void pickBank(b)} ariaLabel={b.name}>
                  <span className="lbl">{b.name}</span>
                </Pill>
              ))}
            </div>
            {shownBanks.length === 0 ? <p className="jny-qsub">{t('bank_no_matches')}</p> : null}
            {/* The way out sits under the banks, quiet: connecting is the point of the step (founder direction 2026-09-14). */}
            <div className="bank-exit">
              <button type="button" className="jny-btn-quiet" onClick={() => dispatch({ type: 'BANK_SKIP', flags })}>
                {t('bank_manual')}
              </button>
            </div>
          </>
        )
      ) : null}

      {phase === 'connecting' ? <Wait text={t('bank_connecting', { bank: state.bankName ?? '' })} /> : null}

      {phase === 'authed' || gather || showCash ? (
      <div className={`bank-stage${gather || showCash ? ' is-swap' : ''}`}>
      {(phase === 'authed' || gather) && !pillsGone ? (
      <div className={`stage-out${gather ? ' is-leaving' : ''}`}>
      {accts === null ? (
          <Wait text={t('bank_loading_accounts')} height={96} />
        ) : (
          <>
            <Pills column>
              {accts.map((a, i) => (
                <Pill
                  key={a.uid}
                  index={i}
                  toggle
                  on={!!ticked[a.uid]}
                  onClick={() => setTicked((prev) => ({ ...prev, [a.uid]: !prev[a.uid] }))}
                  trailing={<><span className="cur">{a.currency === 'SEK' ? '' : a.currency}</span><span className="nr">{a.nr}</span></>}
                >
                  {/* An account another company books is offered like any
                      other, with the claimant named under it: the app cannot
                      know which company is its right home (issue #2647). */}
                  <span className="acct-lbl">
                    <span>{a.name}</span>
                    {a.claimedBy ? <span className="acct-claim">{t('bank_claimed', { company: a.claimedBy })}</span> : null}
                  </span>
                </Pill>
              ))}
            </Pills>
            {tickedClaimed.length > 0 ? <p className="imp-info">{t('bank_claimed_notice')}</p> : null}
          </>
        )}

      {tickedList.length > 0 ? (
        <>
          <Sentence
            open={open}
            onToggle={() => setOpen((v) => !v)}
            changeLabel={t('change')}
            closeLabel={t('close')}
            tools={
              lookback.days > LOOKBACK_SAFE_DAYS ? (
                <button
                  type="button"
                  className={`jny-qhelp${helpOpen ? ' is-on' : ''}`}
                  aria-label={t('bank_long_range_label')}
                  aria-expanded={helpOpen}
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  ?
                </button>
              ) : null
            }
          >
            {tickedList.map((a, i) => (
              <span key={a.uid}>
                {i === 0 ? '' : ', '}
                {i === 0 ? t('bank_ledger_first', { name: a.name, ledger: ledgerOf[a.uid] }) : t('bank_ledger_next', { name: a.name, ledger: ledgerOf[a.uid] })}
              </span>
            ))}
            {'. '}
            {t.rich(
              lookback.rule === 'after_last_entry' ? 'bank_from_after' : lookback.rule === 'fiscal_year' ? 'bank_from_fy' : lookback.rule === 'date' ? 'bank_from_date' : 'bank_from_90',
              { b: (c) => <b>{c}</b>, date: formatDateLong(lookback.fromDate) },
            )}
          </Sentence>
          {open ? (
            <OptRows>
              {tickedList.map((a) => {
                const cur = ledgerOf[a.uid]
                const opts = ledgerOptions(a.currency, [...usedLedgers, ...Object.values(ledgerOf).filter((l) => l !== cur)], cur)
                return (
                  <OptRow
                    key={a.uid}
                    name={a.name}
                    desc={[a.nr, a.currency === 'SEK' ? '' : a.currency].filter(Boolean).join(' · ')}
                    control={
                      <span className="unm-sel">
                        <select
                          className="unm-pick"
                          value={cur}
                          onChange={(e) => setPicks((prev) => ({ ...prev, [a.uid]: e.target.value }))}
                          aria-label={t('bank_ledger_pick', { name: a.name })}
                        >
                          {opts.map((n) => (
                            <option key={n} value={n}>
                              {n} {ledgerName(n, a.currency, chartNames)}
                            </option>
                          ))}
                        </select>
                        <span aria-hidden="true">▾</span>
                      </span>
                    }
                  />
                )
              })}
              <OptRow
                name={t('bank_from_label')}
                desc={lookback.rule === 'after_last_entry' ? t('bank_from_hint_after', { date: formatDateLong(findings?.books.lastEntryDate ?? today) }) : t('bank_from_hint_90')}
                stacked
                control={
                  <div className="acc-picks">
                    {fromDefs.map((o) => (
                      <button key={o.mode} type="button" className={`vpick${mode === o.mode ? ' is-sel' : ''}`} onClick={() => setMode(o.mode)}>
                        {o.label}
                      </button>
                    ))}
                    {mode === 'date' ? (
                      <input type="date" className="from-date" value={customDate} max={today} onChange={(e) => setCustomDate(e.target.value)} aria-label={t('bank_from_opt_date')} />
                    ) : null}
                  </div>
                }
              />
            </OptRows>
          ) : null}
          {helpOpen ? <p className="imp-info">{t('bank_long_range')}</p> : null}
        </>
      ) : null}
      </div>
      ) : null}

      {showCash ? (
        <div className="stage-in">
          <CashLine
            locale={locale}
            fromLabel={formatDateLong(lookback.fromDate)}
            todayLabel={t('today')}
            points={points}
            inflow={inflow}
            onValue={onValue}
          />
          <p className="saldo">
            <b>{fmtKr(saldo, locale)}</b>
            <span>{t('bank_saldo_today', { bank: state.bankName ?? '' })}</span>
          </p>
          <p className="bank-cap" aria-live="polite">
            {txN === 0 ? (
              t('bank_fetching', { bank: state.bankName ?? '' })
            ) : (
              t.rich('bank_caption', { n: txN, accounts: nAcct, matched: txM, review: txR, b: (c) => <b>{c}</b>, attn: (c) => <span className="attn">{c}</span> })
            )}
          </p>
        </div>
      ) : null}
      </div>
      ) : null}

      {/* One column: the primary alone, Hoppa över quietly under it. Tillbaka lives at the top of the act. */}
      <div className="jny-qactions is-stack">
        {(phase === 'connected' && landed) || alreadyConnected ? (
          <button type="button" className="jny-btn" onClick={() => dispatch({ type: 'AFTER_BANK', flags })}>
            {flags.hasSkatteverket ? t('to_skv') : t('to_done')}
          </button>
        ) : null}
        {phase === 'authed' && tickedList.length > 0 ? (
          <button type="button" className="jny-btn" onClick={() => void fetchTransactions()}>
            {t('bank_fetch')}
          </button>
        ) : null}
        {(phase === 'pick' && !alreadyConnected && (!flags.hasBanking || banks === null)) || phase === 'authed' ? (
          <button type="button" className="jny-btn-quiet" onClick={() => dispatch({ type: 'BANK_SKIP', flags })}>
            {t('bank_skip')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
