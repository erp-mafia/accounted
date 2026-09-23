'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { getErrorMessage } from '@/lib/errors/get-error-message'
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

type Phase = 'connect' | 'connecting' | 'token' | 'loading' | 'preview' | 'importing' | 'imported'
type OptKey = 'kunder' | 'lev' | 'kf' | 'lf' | 'anl'

/** The provider's own colour on the one button that leaves for it. */
const BRAND: Record<string, { color: string; dark?: boolean }> = {
  fortnox: { color: '#0b8a46' },
  visma: { color: '#d3202b' },
  bokio: { color: '#1f56ff' },
  bjornlunden: { color: '#f5b400', dark: true },
  briox: { color: '#e05a2b' },
  wint: { color: '#1b1b1b' },
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
  const [accountsN, setAccountsN] = useState(0)
  const [regText, setRegText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
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

  async function connect() {
    if (!providerId) return
    setError(null)
    setPhase('connecting')
    const popup = openProviderWindow()
    try {
      const r = await providerConnect(providerId)
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
  const lines: TheaterLine[] = [
    { title: t('th_read_from', { company: companyName, provider: provName }), sub: t('fact_years', { count: years.length }), tone: 'ok' },
    { title: t('th_map'), sub: created ? t('th_map_sub_new', { count: accountsN, created }) : t('th_map_sub_known', { count: accountsN }) },
    { title: t('th_write'), sub: jobPhase === 'preparing' ? t('th_write_preparing', { total: total.toLocaleString('sv-SE') }) : jobPhase === 'checking' ? t('th_write_checking') : t('progress_written', { count: tick.toLocaleString('sv-SE') }) },
    { title: t('th_registers'), sub: regText },
    { title: t('th_balance'), sub: importError ?? t('th_balance_sub'), tone: importError ? 'err' : 'ok' },
  ]

  async function runImport() {
    if (!consentId || (preview?.sieAvailable !== false && years.length === 0)) return
    setPhase('importing')
    setImportError(null)
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
        const unmapped = data.mappings.filter((m) => !m.targetAccount).map((m) => ({ number: m.sourceAccount, name: data!.parsed.accounts.find((a) => a.number === m.sourceAccount)?.name ?? m.sourceName }))
        if (unmapped.length > 0) {
          const res = await fetch('/api/import/sie/create-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts: unmapped }) })
          if (!res.ok) throw new Error(getErrorMessage(await res.json().catch(() => ({}))))
          setCreated(unmapped.length)
          void invalidateReferenceData('ref:accounts')
        }
        const mappings = data.mappings.map((m) => (m.targetAccount ? m : { ...m, targetAccount: m.sourceAccount, targetName: m.sourceName, matchType: 'exact', confidence: 1, isOverride: true }))
        await new Promise((r) => at(1600, () => r(null)))
        setShown(3)
        // The feed runs for as long as the job does; the count is held at
        // what the worker has actually written (setFeedCap) so the line
        // moves with the import instead of finishing a minute early.
        apiRef.current?.feedVouchers(15 * 60_000, Math.max(1, voucherTotal))
        apiRef.current?.setFeedCap(0)
        setJobPhase('preparing')
        const importedAccounts: string[] = data.parsed.accounts.map((a) => a.number)
        let writtenBefore = 0
        for (let i = 0; i < data.rawContent.length; i++) {
          setJobPhase('preparing')
          setPrepared(0)
          const yearLabel = data.fileStatuses?.[i]?.fiscalYear
          const result = await providerImportSie(data.rawContent[i], mappings, voucherSeries, (job) => {
            const { written, phase } = jobProgress(job)
            setJobPhase(phase)
            setPrepared(job.prepared_through ?? 0)
            setTick(writtenBefore + written)
            apiRef.current?.setFeedCap(Math.min(voucherTotal, writtenBefore + written))
          })
          if (!result.success) throw new Error(`${yearLabel ? `${t('year')} ${yearLabel}: ` : ''}${result.errors.join(' ') || t('provider_failed')}`)
          writtenBefore += result.journalEntriesCreated ?? 0
          setTick(writtenBefore)
          void invalidateReferenceData(['ref:accounts', 'ref:fiscal-periods'])
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
      setImportError(getErrorMessage(err, { locale }))
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
          <button
            type="button"
            className={`brandbtn${BRAND[providerId ?? '']?.dark ? ' is-dark-text' : ''}`}
            style={{ ['--brand' as string]: BRAND[providerId ?? '']?.color }}
            onClick={() => void connect()}
          >
            {provLogo ? (
              <span className="pmark" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={provLogo} alt="" />
              </span>
            ) : null}
            {t('provider_login', { provider: provName })}
          </button>
        </div>
      ) : null}
      {phase === 'connecting' ? <Wait text={t('provider_connecting', { provider: provName })} /> : null}
      {phase === 'loading' ? <Wait text={t('provider_reading', { provider: provName })} /> : null}
      {phase === 'token' ? (
        <div className="tokfields">
          <input type="text" value={tokenB} onChange={(e) => setTokenB(e.target.value)} placeholder={t('tok_company', { provider: provName })} />
          <input type="password" value={tokenA} onChange={(e) => setTokenA(e.target.value)} placeholder={t('tok_token', { provider: provName })} autoComplete="off" />
          <div className="jny-qactions" style={{ marginTop: 12 }}>
            <button type="button" className="jny-btn-quiet" onClick={() => setPhase('connect')}>‹ {t('back')}</button>
            <button type="button" className="jny-btn" disabled={!tokenA} onClick={() => void submitToken()}>{t('tok_connect')}</button>
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
            <button type="button" className="jny-btn" disabled={years.length === 0 && preview.sieAvailable !== false} onClick={() => void runImport()}>
              {years.length === 0 && preview.sieAvailable !== false ? t('years_pick_one') : t('sie_import', { count: years.length })}
            </button>
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

      {/* The door onward opens only on a successful import: a failed one
          (0 of N vouchers written) must never reach the bank step or Klart.
          A failed attempt never blocks the retry (sie_imports 'failed' rows
          are ignored by the overlap check) and the opening balance it may
          have written is skipped, not duplicated, on the next run. */}
      {phase === 'imported' && !importError ? (
        <div className="jny-qactions">
          <button type="button" className="jny-btn" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
            {flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')}
          </button>
        </div>
      ) : null}
      {phase === 'imported' && importError ? (
        <div className="jny-qactions">
          <button type="button" className="jny-btn" onClick={() => { setShown(0); setTick(0); void runImport() }}>
            {t('provider_retry')}
          </button>
          <button type="button" className="jny-btn-quiet" onClick={() => dispatch({ type: 'GO_BACK', flags })}>
            {t('provider_change_source')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
