'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { SIEJobFailedError } from '@/lib/import/sie-job-client'
import { formatImportFailure } from '@/lib/import/import-failure'
import { countSieVouchers, importProviderYears, planProviderYears, providerYearsComplete, type ProviderYearsOutcome } from '@/lib/onboarding-books/provider-years'
import { resolveOnboardingMappings } from '@/lib/onboarding-books/mappings'
import { obsAccountsOf } from '@/lib/import/sie-preview-mappings'
import { jobProgress, type JobPhase } from '../lib/job-progress'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useCompanySettings } from '@/components/settings/useSettings'
import { BRANCH_PROVIDERS } from '@/lib/onboarding-journey/branch'
import type { ParsedSIEFile } from '@/lib/import/types'
import { InkText } from '@/components/onboarding/journey/ink'
import type { TheaterApi } from '../engines/theater-engine'
import { Theater, type TheaterLine, type TheaterModelInput } from '../ui/Theater'
import { Wait } from '../ui/Verdicts'
import { InsightPanel } from '../ui/InsightPanel'
import { Pill, Pills } from '../ui/Pills'
import { OptRow, OptRows, Sentence, Switch } from '../ui/Sentence'
import {
  openProviderWindow, pointWindow, providerAccept, providerConnect, providerImportSie, providerMigrate, providerPreview, providerSieData,
  providerSubmitToken, takeReturnedConsentId, useProviderMessage, type ProviderPreview, type ProviderSieData,
} from '../lib/provider'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'

type Phase = 'connect' | 'connecting' | 'token' | 'loading' | 'preview' | 'importing' | 'imported'
type OptKey = 'kunder' | 'lev' | 'kf' | 'lf' | 'anl'

/** The provider's own colour on the one button that leaves for it: a
 *  depiction of a third party's brand, so these stay literal (not theme tokens). */
const BRAND: Record<string, { color: string; dark?: boolean }> = {
  fortnox: { color: '#0b8a46' },
  visma: { color: '#d3202b' },
  bokio: { color: '#1f56ff' },
  bjornlunden: { color: '#f5b400', dark: true },
  briox: { color: '#e05a2b' },
  wint: { color: '#1b1b1b' },
}
const BRAND_TEXT = { light: '#fff', dark: '#171717' }

/** A run that left a selected year out of the books. `text` names the
 *  years and is written here from our own strings, so it is shown as is,
 *  never re-mapped; `message` stays technical like any other Error. */
class YearsMissingError extends Error {
  constructor(readonly text: string) {
    super('selected years missing from the books')
    this.name = 'YearsMissingError'
  }
}

/**
 * Hämtar från det gamla systemet: log in at the provider (popup, the
 * callback posts back), the facts ink in, the years as pills with the
 * default selection ticked, one sentence with Ändra behind it, then the
 * theater: SIE per year through the same engine as the Import page, then
 * kunder, leverantörer and fakturor as a stream driving the register stage.
 */
export function ProviderStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { state, dispatch, flags, loadFindings } = ctx
  const { settings } = useCompanySettings()
  const providerId = state.provider
  const provName = useMemo(() => BRANCH_PROVIDERS.find((p) => p.id === providerId)?.name ?? t('provider_generic'), [providerId, t])
  const provLogo = useMemo(() => BRANCH_PROVIDERS.find((p) => p.id === providerId)?.logo ?? null, [providerId])
  // What the provider charges or requires before its login can succeed,
  // said before the click in the migration workspace's own words, so the
  // paid add-on is not first met on the provider's page.
  const tx = useTranslations('extensions')
  const requirement = providerId === 'fortnox'
    ? tx('ext_arcim_requirement_fortnox')
    : providerId === 'visma'
      ? tx('ext_arcim_requirement_visma')
      : null
  const [phase, setPhase] = useState<Phase>('connect')
  const [error, setError] = useState<string | null>(null)
  const [consentId, setConsentId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ProviderPreview | null>(null)
  const [years, setYears] = useState<number[]>([])
  const [opts, setOpts] = useState<Record<OptKey, boolean>>({ kunder: true, lev: true, kf: true, lf: true, anl: providerId === 'fortnox' })
  const [optsOpen, setOptsOpen] = useState(false)
  const [tokenA, setTokenA] = useState('')
  const [tokenB, setTokenB] = useState('')
  const [model, setModel] = useState<TheaterModelInput | null>(null)
  const [shown, setShown] = useState(0)
  const [tick, setTick] = useState(0)
  const [prepared, setPrepared] = useState(0)
  const [total, setTotal] = useState(0)
  const [created, setCreated] = useState(0)
  const [obs, setObs] = useState<string[]>([])
  const [accountsN, setAccountsN] = useState(0)
  const [regText, setRegText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [keptYears, setKeptYears] = useState<number[]>([])
  const [unfetched, setUnfetched] = useState<number[]>([])
  const [jobPhase, setJobPhase] = useState<JobPhase | null>(null)
  const apiRef = useRef<TheaterApi | null>(null)
  const timers = useRef<number[]>([])
  const at = useCallback((ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)) }, [])
  useEffect(() => {
    const list = timers.current
    return () => list.forEach((id) => window.clearTimeout(id))
  }, [])

  const loadPreview = useCallback(async (cId: string) => {
    setConsentId(cId)
    setPhase('loading')
    setError(null)
    try {
      const p = await providerPreview(cId)
      setPreview(p)
      setYears((p.sourceYears ?? []).filter((y) => y.inDefaultSelection).map((y) => y.year))
      setPhase('preview')
    } catch (err) {
      setError(getErrorMessage(err, { locale }))
      setPhase('connect')
    }
  }, [locale])

  // A full-page round trip brought a consentId in the URL.
  const returned = useRef(false)
  useEffect(() => {
    if (returned.current) return
    returned.current = true
    const cId = takeReturnedConsentId()
    if (cId) void loadPreview(cId)
  }, [loadPreview])

  useProviderMessage(
    (cId) => void loadPreview(cId),
    (reason) => { setError(getErrorMessage(reason, { locale })); setPhase('connect') },
  )

  // The login popup belongs to this step. Leaving it (SIE instead, Tillbaka)
  // closes the popup and drops a connect still in flight: a login finished
  // there would otherwise post its success to the next step's own listener
  // (SieStep runs the registers on it), and pointWindow with a closed popup
  // sends the main window to the provider.
  const login = useRef<{ popup: Window | null; left: boolean }>({ popup: null, left: false })
  useEffect(() => {
    const l = login.current
    l.left = false
    return () => { l.left = true; l.popup?.close() }
  }, [])

  async function connect() {
    if (!providerId) return
    setError(null)
    setPhase('connecting')
    const popup = openProviderWindow()
    login.current.popup = popup
    try {
      const r = await providerConnect(providerId)
      if (login.current.left) return
      setConsentId(r.consentId)
      if (r.alreadyConnected) { popup?.close(); void loadPreview(r.consentId); return }
      if (r.authType === 'oauth' && r.authUrl) { pointWindow(popup, r.authUrl); return }
      popup?.close()
      setPhase('token')
    } catch (err) {
      popup?.close()
      setError(getErrorMessage(err, { locale }))
      setPhase('connect')
    }
  }

  async function submitToken() {
    if (!consentId || !providerId) return
    setPhase('connecting')
    try {
      await providerSubmitToken(consentId, providerId, tokenA, tokenB)
      void loadPreview(consentId)
    } catch (err) {
      setError(getErrorMessage(err, { locale }))
      setPhase('token')
    }
  }

  /* ── preview: the facts, the years, the sentence ─────────────────── */
  const sourceYears = useMemo(() => preview?.sourceYears ?? [], [preview])
  const maxYears = preview?.maxSelectedYears ?? 6
  const companyName = preview?.companyInfo?.company_name || preview?.consent.companyName || ''
  const scopeParts = useMemo(() => {
    const parts: string[] = []
    if (opts.kunder) parts.push(t('scope_customers'))
    if (opts.lev) parts.push(t('scope_suppliers'))
    if (opts.kf && opts.lf) parts.push(t('scope_invoices'))
    else if (opts.kf) parts.push(t('scope_sales_invoices'))
    else if (opts.lf) parts.push(t('scope_supplier_invoices'))
    if (opts.anl) parts.push(t('scope_assets'))
    if (parts.length === 0) return ''
    if (parts.length === 1) return `, ${parts[0]}`
    return `, ${parts.slice(0, -1).join(', ')} ${t('and')} ${parts[parts.length - 1]}`
  }, [opts, t])

  const optDefs: { key: OptKey; name: string; desc: string }[] = [
    { key: 'kunder', name: t('opt_customers'), desc: t('opt_customers_desc') },
    { key: 'lev', name: t('opt_suppliers'), desc: t('opt_suppliers_desc') },
    { key: 'kf', name: t('opt_sales_invoices'), desc: t('opt_sales_invoices_desc') },
    { key: 'lf', name: t('opt_supplier_invoices'), desc: providerId === 'fortnox' ? t('opt_supplier_invoices_desc_fortnox') : t('opt_sales_invoices_desc') },
    ...(providerId === 'fortnox' ? [{ key: 'anl' as OptKey, name: t('opt_assets'), desc: t('opt_assets_desc') }] : []),
  ]

  /* ── import ──────────────────────────────────────────────────────── */
  // Years as a list: "2024 och 2025". Strings, so ICU never groups them as numbers.
  const listYears = (ys: number[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(ys.map(String))
  const yearsSub = t('fact_years', { count: years.length })
  const lines: TheaterLine[] = [
    { title: t('th_read_from', { company: companyName, provider: provName }), sub: keptYears.length > 0 ? `${yearsSub} · ${t('fact_years_kept', { count: keptYears.length, years: listYears(keptYears) })}` : yearsSub, tone: 'ok' },
    // This flow has no mapping page: name the class 9 accounts that land on 2999, as the SIE step does.
    { title: t('th_map'), sub: [created ? t('th_map_sub_new', { count: accountsN, created }) : t('th_map_sub_known', { count: accountsN }), ...(obs.length > 0 ? [t('fact_obs_to_2999', { accounts: obs.join(', ') })] : [])].join(' · ') },
    { title: t('th_write'), sub: jobPhase === 'preparing' ? t('th_write_preparing', { total: total.toLocaleString('sv-SE') }) : jobPhase === 'checking' ? t('th_write_checking') : t('progress_written', { count: tick.toLocaleString('sv-SE') }) },
    { title: t('th_registers'), sub: regText },
    { title: t('th_balance'), sub: importError ?? t('th_balance_sub'), tone: importError ? 'err' : 'ok' },
  ]

  /** The result of a run that left selected years out of the books: which,
   *  and why. A failed job's reason spans lines (bullets, then its
   *  reference), so what follows it starts on a line of its own. */
  function missingYearsText(o: ProviderYearsOutcome): string {
    const lines: string[] = []
    if (o.failed) {
      if (o.failed.fiscalYear !== null) lines.push(t('provider_year_failed', { year: String(o.failed.fiscalYear) }))
      if (o.failed.reason) lines.push(o.failed.reason)
      else if (o.failed.fiscalYear === null) lines.push(t('sie_failed'))
    }
    const rest: string[] = []
    if (o.notReached.length > 0) rest.push(t('provider_years_not_reached', { count: o.notReached.length, years: listYears(o.notReached) }))
    if (o.notFetched.length > 0) rest.push(t('provider_years_not_fetched', { count: o.notFetched.length, years: listYears(o.notFetched), provider: provName }))
    if (o.imported.length + o.alreadyImported.length > 0) rest.push(t('provider_retry_missing'))
    if (rest.length > 0) lines.push(rest.join(' '))
    return lines.join('\n')
  }

  async function runImport() {
    if (!consentId || (preview?.sieAvailable !== false && years.length === 0)) return
    setPhase('importing')
    setImportError(null)
    setObs([])
    setKeptYears([])
    setUnfetched([])
    setTick(0)
    setPrepared(0)
    setJobPhase('preparing')
    setOptsOpen(false)
    dispatch({ type: 'SET_WORKING', working: true })
    at(300, () => setShown(1))
    const voucherSeries = settings?.default_voucher_series || null
    try {
      let data: ProviderSieData | null = null
      let voucherTotal = 0
      if (preview?.sieAvailable !== false) {
        data = await providerSieData(consentId, years)
        try {
          const { buildTheaterModel } = await import('@/lib/import/theater-model')
          const m = buildTheaterModel(data.parsed as unknown as ParsedSIEFile)
          setModel({
            company: m.companyName || companyName,
            accounts: m.accounts.map((a) => ({ number: a.number, name: a.name, weight: a.weight })),
            counterparties: m.counterparties.map((c) => ({ name: c.name, account: c.account, weight: c.weight })),
          })
          voucherTotal = m.totalVouchers
          setTotal(voucherTotal)
        } catch {
          setModel({ company: companyName, accounts: [], counterparties: [] })
        }
        setAccountsN(data.mappingStats.total)
        setShown(2)
        at(200, () => apiRef.current?.spawnAccounts())
        // The server decided every target it can (class 9 amounts to 2999).
        // A blank left over that no chart can hold stops here, before any
        // write: mapped onto itself it was refused one call later (#3312).
        const resolved = resolveOnboardingMappings(data.mappings, data.parsed.accounts)
        if (resolved.unresolved.length > 0) {
          throw new Error(t('accounts_outside_bas', { count: resolved.unresolved.length, accounts: resolved.unresolved.join(', ') }))
        }
        setObs(obsAccountsOf(resolved.mappings))
        if (resolved.create.length > 0) {
          const res = await fetch('/api/import/sie/create-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: resolved.create }) })
          if (!res.ok) throw new Error(getErrorMessage(await res.json().catch(() => ({}))))
          setCreated(resolved.create.length)
          void invalidateReferenceData('ref:accounts')
        }
        const mappings = resolved.mappings
        await new Promise((r) => at(1600, () => r(null)))
        setShown(3)
        // A year a completed import already holds is not sent again (a retry
        // after a failed year died on it before reaching the missing one),
        // and the count to write is then only the years still to come.
        const plan = planProviderYears(data)
        setKeptYears(plan.alreadyImported)
        if (plan.alreadyImported.length > 0) {
          const files = data.rawContent
          voucherTotal = plan.pending.reduce((n, f) => n + countSieVouchers(files[f.index]), 0)
          setTotal(voucherTotal)
        }
        // The feed runs for as long as the job does; the count is held at
        // what the worker has actually written (setFeedCap) so the line
        // moves with the import instead of finishing a minute early.
        apiRef.current?.feedVouchers(15 * 60_000, Math.max(1, voucherTotal))
        apiRef.current?.setFeedCap(0)
        setJobPhase('preparing')
        const importedAccounts: string[] = data.parsed.accounts.map((a) => a.number)
        let writtenBefore = 0
        const outcome = await importProviderYears(data, async (rawContent) => {
          setJobPhase('preparing')
          setPrepared(0)
          const result = await providerImportSie(rawContent, mappings, voucherSeries, (job) => {
            const { written, phase } = jobProgress(job)
            setJobPhase(phase)
            setPrepared(job.prepared_through ?? 0)
            setTick(writtenBefore + written)
            apiRef.current?.setFeedCap(Math.min(voucherTotal, writtenBefore + written))
          })
          if (result.success) {
            writtenBefore += result.journalEntriesCreated ?? 0
            setTick(writtenBefore)
            void invalidateReferenceData(['ref:accounts', 'ref:fiscal-periods'])
          }
          return result
        }, (err) => (err instanceof SIEJobFailedError ? formatImportFailure(err.failure) : getErrorMessage(err, { locale })))
        // Registers, the insight and the door onward wait until every
        // selected year is in the books.
        if (!providerYearsComplete(outcome)) {
          setUnfetched(outcome.notFetched)
          throw new YearsMissingError(missingYearsText(outcome))
        }
        setJobPhase(null)
        apiRef.current?.pulse()
        dispatch({ type: 'IMPORTED', accounts: importedAccounts })
        at(400, () => apiRef.current?.spawnCounterparties())
      } else {
        setJobPhase(null)
        setModel({ company: companyName, accounts: [], counterparties: [] })
        setShown(3)
      }
      // Registers as a stream; the theater's register stage rides the counts.
      const wantsRegisters = opts.kunder || opts.lev || opts.kf || opts.lf || opts.anl
      setShown(4)
      if (wantsRegisters) {
        setRegText(t('reg_running'))
        const results = await providerMigrate(consentId, { importCustomers: opts.kunder, importSuppliers: opts.lev, importSalesInvoices: opts.kf, importSupplierInvoices: opts.lf, importAssets: opts.anl }, (step) => {
          if (step) setRegText(step)
        })
        const invoices = (results.salesInvoices?.imported ?? 0) + (results.supplierInvoices?.imported ?? 0)
        setRegText(t('reg_summary', { customers: results.customers?.imported ?? 0, suppliers: results.suppliers?.imported ?? 0, invoices }))
        await new Promise<void>((resolve) => {
          const api = apiRef.current
          if (!api || invoices === 0) { resolve(); return }
          api.registerStage({ source: provName, ms: Math.min(6000, Math.max(2200, invoices * 25)), invoices: [['1510', results.salesInvoices?.imported ?? 0], ['2440', results.supplierInvoices?.imported ?? 0]], onProgress: (r) => { if (r.done) resolve() } })
          at(8000, () => resolve())
        })
        if (results.stepErrors?.length) setRegText(results.stepErrors.map((e) => getErrorMessage(e, { locale })).join(' '))
      } else {
        setRegText(t('reg_skipped'))
      }
      await providerAccept(consentId)
      setShown(5)
      apiRef.current?.settle()
      void loadFindings()
      await new Promise((r) => at(900, () => r(null)))
      setPhase('imported')
    } catch (err) {
      setImportError(err instanceof YearsMissingError ? err.text : getErrorMessage(err, { locale }))
      setJobPhase(null)
      setShown(5)
      apiRef.current?.settle()
      setPhase('imported')
    } finally {
      dispatch({ type: 'SET_WORKING', working: false })
    }
  }

  /* ── render ──────────────────────────────────────────────────────── */
  return (
    <div className="bks-host">
      <div className="jny-qstep" style={{ textAlign: 'center' }}>
        <h1 className="jny-qtitle"><InkText text={t('provider_title')} /></h1>
        {phase === 'connect' || phase === 'connecting' || phase === 'token' ? <p className="jny-qsub">{t('provider_sub')}</p> : null}
        {error ? <p className="jny-attn">{error}</p> : null}
      </div>

      {phase === 'connect' ? (
        <div className="bks-center-col">
          {requirement ? <p className="brandreq">{requirement}</p> : null}
          <Button
            size="lg"
            className="brandbtn animate-fade-in gap-2 pl-2"
            style={BRAND[providerId ?? ''] ? { backgroundColor: BRAND[providerId ?? ''].color, color: BRAND[providerId ?? ''].dark ? BRAND_TEXT.dark : BRAND_TEXT.light } : undefined}
            onClick={() => void connect()}
          >
            {provLogo ? (
              <span className="pmark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={provLogo} alt="" />
              </span>
            ) : null}
            {t('provider_login', { provider: provName })}
          </Button>
        </div>
      ) : null}
      {phase === 'connecting' ? <Wait text={t('provider_connecting', { provider: provName })} /> : null}
      {/* The SIE way round the login, on the same screen. Also while
          connecting: a popup closed on the provider's licence page sends
          no message back, so the step would otherwise wait there. */}
      {phase === 'connect' || phase === 'connecting' ? (
        <div className="bks-center-col" style={{ marginTop: 18 }}>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => dispatch({ type: 'PICK_SIE' })}>
            {t('provider_sie_instead')}
          </Button>
          <p className="brandhint">
            {BRANCH_PROVIDERS.some((p) => p.id === providerId)
              ? t('provider_sie_instead_note', { provider: provName })
              : t('provider_sie_instead_note_generic')}
          </p>
        </div>
      ) : null}
      {phase === 'loading' ? <Wait text={t('provider_reading', { provider: provName })} /> : null}
      {phase === 'token' ? (
        <div className="tokfields">
          <input type="text" value={tokenB} onChange={(e) => setTokenB(e.target.value)} placeholder={t('tok_company', { provider: provName })} />
          <input type="password" value={tokenA} onChange={(e) => setTokenA(e.target.value)} placeholder={t('tok_token', { provider: provName })} autoComplete="off" />
          <div className="jny-qactions" style={{ marginTop: 12 }}>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPhase('connect')}>‹ {t('back')}</Button>
            <Button size="lg" disabled={!tokenA} onClick={() => void submitToken()}>{t('tok_connect')}</Button>
          </div>
        </div>
      ) : null}

      {phase === 'preview' && preview ? (
        <>
          <p className="connline">
            {provLogo ? (
              <span className="pmark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={provLogo} alt="" />
              </span>
            ) : null}
            <span>{t('provider_connected', { provider: provName })}</span>
            {companyName ? <span style={{ color: 'hsl(var(--muted-foreground))' }}>· {companyName}</span> : null}
          </p>
          <dl className="stats">
            <div className="stat" style={{ animationDelay: '0ms' }}>
              <dt>{t('stat_years')}</dt>
              <dd>
                {sourceYears.length || preview.sieStats?.fiscalYears.length || 0}
                {sourceYears.length > 1 ? <small>{sourceYears[0].year} till {sourceYears[sourceYears.length - 1].year}</small> : null}
              </dd>
            </div>
            <div className="stat" style={{ animationDelay: '120ms' }}>
              <dt>{t('stat_accounts')}</dt>
              <dd>{(preview.sieStats?.accountCount ?? 0).toLocaleString('sv-SE')}</dd>
            </div>
            <div className="stat" style={{ animationDelay: '240ms' }}>
              <dt>{t('stat_vouchers')}</dt>
              <dd>{(preview.sieStats?.transactionCount ?? 0).toLocaleString('sv-SE')}</dd>
            </div>
          </dl>
          {sourceYears.length > 1 ? (
            <div className="imp-sec">
              <p className="imp-k">{t('years_label')}</p>
              <Pills>
                {sourceYears.map((y, i) => {
                  const on = years.includes(y.year)
                  return (
                    <Pill
                      key={y.year}
                      index={i}
                      toggle
                      on={on}
                      onClick={() => setYears((prev) => (on ? prev.filter((v) => v !== y.year) : prev.length >= maxYears ? prev : [...prev, y.year].sort()))}
                      trailing={!y.inDefaultSelection ? <span className="old">{t('years_older')}</span> : undefined}
                    >
                      {y.year}
                    </Pill>
                  )
                })}
              </Pills>
            </div>
          ) : null}
          <Sentence open={optsOpen} onToggle={() => setOptsOpen((v) => !v)} changeLabel={t('change')} closeLabel={t('close')}>
            {t.rich('provider_sentence', { years: years.length, b: (c) => <b>{c}</b> })}
            {scopeParts}.
          </Sentence>
          {optsOpen ? (
            <OptRows>
              {optDefs.map((o) => (
                <OptRow key={o.key} name={o.name} desc={o.desc} off={!opts[o.key]} control={<Switch on={opts[o.key]} onToggle={() => setOpts((p) => ({ ...p, [o.key]: !p[o.key] }))} label={o.name} />} />
              ))}
            </OptRows>
          ) : null}
          <div className="jny-qactions">
            <Button size="lg" disabled={years.length === 0 && preview.sieAvailable !== false} onClick={() => void runImport()}>
              {years.length === 0 && preview.sieAvailable !== false ? t('years_pick_one') : t('sie_import', { count: years.length })}
            </Button>
          </div>
        </>
      ) : null}

      {phase === 'importing' || phase === 'imported' ? (
        <Theater
          model={model}
          lines={lines}
          shown={shown}
          settled={phase === 'imported'}
          hold={phase === 'importing' ? t('sie_hold_open') : null}
          progress={jobPhase || shown === 3 ? {
            phase: importError ? 'failed' : jobPhase ?? 'checking',
            written: tick,
            total,
            prepared,
          } : undefined}
          onApi={(api) => { apiRef.current = api }}
          groupLabels={{ tillgangar: t('grp_assets'), skulder: t('grp_liabilities'), intakter: t('grp_revenue'), kostnader: t('grp_costs') }}
          reviewLabel={t('grp_review')}
        />
      ) : null}

      {phase === 'imported' && !importError ? (
        <div style={{ marginTop: 22 }}>
          <InsightPanel ctx={ctx} base={300} summary />
        </div>
      ) : null}

      {/* The door onward opens only when every selected year is in: a failed
          or missing year must never reach the bank step or Klart.
          A failed attempt never blocks the retry (sie_imports 'failed' rows
          are ignored by the overlap check) and the opening balance it may
          have written is skipped, not duplicated, on the next run. Years
          that did complete are skipped by the retry, not sent again. */}
      {phase === 'imported' && !importError ? (
        <div className="jny-qactions">
          <Button size="lg" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
            {flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')}
          </Button>
        </div>
      ) : null}
      {phase === 'imported' && importError ? (
        <div className="jny-qactions">
          <Button size="lg" onClick={() => { setShown(0); setTick(0); void runImport() }}>
            {t('provider_retry')}
          </Button>
          {/* A year the provider will not hand over is fetched again by a
              retry. Back to the years instead, where it can be left out as
              on a first run; the preview is still in memory. */}
          {unfetched.length > 0 && sourceYears.length > 1 ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setShown(0); setTick(0); setImportError(null); setPhase('preview') }}>
              {t('provider_pick_years')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => dispatch({ type: 'GO_BACK', flags })}>
            {t('provider_change_source')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
