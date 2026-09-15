'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  acceptSourceChartWithoutReview,
  applySourceChartCsv,
} from '@/lib/import/source-chart/apply-source-chart'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { waitForSIEJob } from '@/lib/import/sie-job-client'
import { jobProgress, type JobPhase } from '../lib/job-progress'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useCompanySettings } from '@/components/settings/useSettings'
import { BRANCH_PROVIDERS } from '@/lib/onboarding-journey/branch'
import { SIE_FIRST_PROVIDERS } from '@/lib/onboarding-books/reducer'
import { defaultOpeningBalanceSeries } from '@/lib/import/opening-balance-defaults'
import type { AccountMapping, ImportPreview, SIEAccount, SIEHeader } from '@/lib/import/types'
import { InkText } from '@/components/onboarding/journey/ink'
import type { TheaterApi } from '../engines/theater-engine'
import { Theater, type TheaterLine, type TheaterModelInput } from '../ui/Theater'
import { Facts, Wait } from '../ui/Verdicts'
import { InsightPanel } from '../ui/InsightPanel'
import { OptRow, OptRows, Sentence, Switch } from '../ui/Sentence'
import {
  openProviderWindow, pointWindow, providerAccept, providerConnect, providerMigrate, providerSubmitToken, useProviderMessage,
} from '../lib/provider'
import type { BooksCtx } from '../context'

const THEATER_MAX_FILE_BYTES = 8 * 1024 * 1024

interface ParsedFile {
  header: SIEHeader
  stats: { totalAccounts: number; totalVouchers: number; fiscalYearStart: string | null; fiscalYearEnd: string | null }
  accounts: SIEAccount[]
  mappings: AccountMapping[]
  preview: ImportPreview
}

interface FileEntry {
  id: string
  file: File
  status: 'parsing' | 'ready' | 'dup' | 'error'
  parsed?: ParsedFile
  error?: string
  dupImportId?: string
  /**
   * What this year's chart of accounts export did, once the user picked one.
   * Per file because the chart belongs to a fiscal year: codes move between
   * years, and last year's chart on this year's ledger is the quiet way to a
   * wrong ruta.
   */
  chart?: { name: string; applied: boolean; treatments: number; format: string | null }
}

type Phase = 'drop' | 'importing' | 'imported'
type Reg = null | 'card' | 'connecting' | 'token' | 'running' | 'done' | 'skipped'

/**
 * A chart filename short enough to sit beside the SIE file it belongs to.
 *
 * The drop surface is 560px wide and centred, and a Spiris export is named
 * ChartAccounts_Export_20260914-2021.csv: thirty of those thirty-eight
 * characters are the same on every row, and they pushed the count onto a line
 * of its own. Elided in the middle rather than truncated at the end, because
 * the tail is the half that matters here; the year is what says the chart was
 * paired with the right ledger. The full name stays in the title attribute.
 */
function shortChartName(name: string): string {
  if (name.length <= 24) return name
  return `${name.slice(0, 10)}…${name.slice(-12)}`
}

function yearsOf(files: FileEntry[]): string[] {
  const set = new Set<string>()
  for (const f of files) for (const y of f.parsed?.header.fiscalYears ?? []) set.add(y.start)
  return Array.from(set)
}

/**
 * Ladda upp SIE-filen: drop one or more SIE 4 files, the facts ink in, one
 * sentence says what will be read with Ändra behind it, then the theater
 * runs while the server writes, oldest year first. Unmapped accounts are
 * created from the file, no mapping page, no VAT review gate: momskoder
 * for revenue accounts are set on the genomlysning instead. Only a selected
 * SIE-first provider offers its registers afterward; files alone go onward.
 */
export function SieStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { state, dispatch, flags, loadFindings } = ctx
  const { settings } = useCompanySettings()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const chartInputRef = useRef<HTMLInputElement | null>(null)
  const chartForFile = useRef<string | null>(null)
  const [over, setOver] = useState(false)
  const [optsOpen, setOptsOpen] = useState(false)
  const [ibOn, setIbOn] = useState<boolean | null>(null)
  const [namesOn, setNamesOn] = useState(true)
  const [phase, setPhase] = useState<Phase>('drop')
  const [model, setModel] = useState<TheaterModelInput | null>(null)
  const [shown, setShown] = useState(0)
  const [tick, setTick] = useState(0)
  const [prepared, setPrepared] = useState(0)
  const [jobPhase, setJobPhase] = useState<JobPhase | null>(null)
  const [written, setWritten] = useState(0)
  const [fileIdx, setFileIdx] = useState(0)
  const [created, setCreated] = useState(0)
  const [importError, setImportError] = useState<string | null>(null)
  const [reg, setReg] = useState<Reg>(null)
  const regProvider = state.provider
  const [regShown, setRegShown] = useState(0)
  const [regTick, setRegTick] = useState(0)
  const [regCounts, setRegCounts] = useState<{ customers: number; suppliers: number; invoices: number; linked: number } | null>(null)
  const [regError, setRegError] = useState<string | null>(null)
  const [consentId, setConsentId] = useState<string | null>(null)
  const [tokenA, setTokenA] = useState('')
  const [tokenB, setTokenB] = useState('')
  const apiRef = useRef<TheaterApi | null>(null)
  const timers = useRef<number[]>([])
  const at = useCallback((ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)) }, [])
  useEffect(() => {
    const list = timers.current
    return () => list.forEach((id) => window.clearTimeout(id))
  }, [])

  const provName = useMemo(() => BRANCH_PROVIDERS.find((p) => p.id === regProvider)?.name ?? null, [regProvider])
  const sieFirst = SIE_FIRST_PROVIDERS.has(state.provider ?? '')

  /* ── parse ───────────────────────────────────────────────────────── */
  const parseOne = useCallback(async (file: File, id: string) => {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/import/sie/parse', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        const code = data?.error?.code as string | undefined
        const message = getErrorMessage(data)
        const importId = data?.error?.details?.importId as string | undefined
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: code === 'SIE_DUPLICATE_FILE' || code === 'SIE_DUPLICATE_PERIOD' ? 'dup' : 'error', error: message, dupImportId: importId } : f)))
        return
      }
      const parsed: ParsedFile = { header: data.parsed.header, stats: data.parsed.stats, accounts: data.parsed.accounts, mappings: data.mappings, preview: data.preview }
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'ready', parsed } : f)))
    } catch {
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: 'error', error: t('sie_network') } : f)))
    }
  }, [t])

  /**
   * The chart of accounts the source system exports, for one SIE file's year.
   *
   * Applied and accepted in the same step: this act has no mapping page to
   * confirm on, and the alternative is not a review, it is nothing at all.
   * buildSIEVatDefaults writes a treatment only for a row marked reviewed, so
   * an unaccepted chart would leave the ledger exactly as momskod-less as it
   * is today. Only codes the translator could read are accepted; the rest stay
   * open for the genomlysning.
   *
   * The empty chart argument is the company's own: in this act it is created
   * by the very import being prepared, so there is nothing to restore against.
   */
  async function applyChart(fileId: string, file: File) {
    try {
      const csv = await file.text()
      setFiles((prev) => prev.map((f) => {
        if (f.id !== fileId || !f.parsed) return f
        const result = applySourceChartCsv(f.parsed.mappings, csv, [])
        return {
          ...f,
          parsed: { ...f.parsed, mappings: acceptSourceChartWithoutReview(result.mappings) },
          chart: {
            name: file.name,
            applied: result.applied,
            treatments: result.summary.treatmentsApplied,
            format: result.summary.formatLabel,
          },
        }
      }))
    } catch {
      setFiles((prev) => prev.map((f) => (
        f.id === fileId ? { ...f, chart: { name: file.name, applied: false, treatments: 0, format: null } } : f
      )))
    }
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter((f) => /\.(se|sie)$/i.test(f.name) || f.size > 0)
    if (incoming.length === 0) return
    const entries = incoming.map((file) => ({ id: crypto.randomUUID(), file, status: 'parsing' as const }))
    setFiles((prev) => [...prev, ...entries])
    entries.forEach(({ file, id }) => void parseOne(file, id))
  }

  async function replaceDup(id: string) {
    const f = files.find((entry) => entry.id === id)
    if (!f?.dupImportId) return
    setFiles((prev) => prev.map((x) => (x.id === id ? { ...x, status: 'parsing', error: undefined } : x)))
    try {
      const res = await fetch(`/api/import/sie/${f.dupImportId}/replace`, { method: 'POST' })
      if (!res.ok) throw new Error(getErrorMessage(await res.json().catch(() => ({}))))
      await parseOne(f.file, id)
    } catch (err) {
      setFiles((prev) => prev.map((x) => (x.id === id ? { ...x, status: 'error', error: getErrorMessage(err, { locale }) } : x)))
    }
  }

  const ready = useMemo(() => files.filter((f) => f.status === 'ready' && f.parsed), [files])
  const ordered = useMemo(() => [...ready].sort((a, b) => (a.parsed!.stats.fiscalYearStart ?? '').localeCompare(b.parsed!.stats.fiscalYearStart ?? '')), [ready])
  const parsing = files.some((f) => f.status === 'parsing')
  const company = ready[0]?.parsed?.header.companyName ?? null
  const nYears = yearsOf(ready).length || ready.length
  const totalVouchers = ready.reduce((s, f) => s + (f.parsed?.stats.totalVouchers ?? 0), 0)
  const totalAccounts = ready.reduce((s, f) => s + (f.parsed?.stats.totalAccounts ?? 0), 0)
  const unmapped = useMemo(() => {
    const seen = new Set<string>()
    const out: SIEAccount[] = []
    for (const f of ready) for (const m of f.parsed!.mappings) {
      if (!m.targetAccount && !seen.has(m.sourceAccount)) {
        seen.add(m.sourceAccount)
        const acc = f.parsed!.accounts.find((a) => a.number === m.sourceAccount)
        out.push({ number: m.sourceAccount, name: acc?.name ?? m.sourceName })
      }
    }
    return out
  }, [ready])
  const hasIb = ready.some((f) => (f.parsed?.preview.openingBalanceTotal ?? 0) > 0)
  const ib = ibOn ?? hasIb
  const ibAmount = ready.reduce((s, f) => s + (f.parsed?.preview.openingBalanceTotal ?? 0), 0)

  const facts = useMemo(() => {
    if (ready.length === 0) return []
    const list: { text: string; warn?: boolean }[] = []
    if (company) list.push({ text: company })
    list.push({ text: t('fact_years', { count: nYears }) })
    list.push({ text: t('fact_vouchers', { count: totalVouchers }) })
    list.push(unmapped.length === 0 ? { text: t('fact_accounts_known', { count: totalAccounts }) } : { text: t('fact_accounts_new', { count: totalAccounts, created: unmapped.length }) })
    return list
  }, [ready, company, nYears, totalVouchers, totalAccounts, unmapped.length, t])

  /* ── import ──────────────────────────────────────────────────────── */
  const lines: TheaterLine[] = [
    { title: t('th_read', { company: company ?? '' }), sub: t('fact_years', { count: nYears }), tone: 'ok' },
    { title: t('th_map'), sub: unmapped.length ? t('th_map_sub_new', { count: totalAccounts, created: created || unmapped.length }) : t('th_map_sub_known', { count: totalAccounts }) },
    { title: t('th_write'), sub: jobPhase === 'preparing' ? t('th_write_preparing', { total: totalVouchers.toLocaleString('sv-SE') }) : jobPhase === 'checking' ? t('th_write_checking') : t('progress_written', { count: tick.toLocaleString('sv-SE') }) },
    { title: t('th_parties'), sub: model ? t('th_parties_sub', { count: model.counterparties.length }) : '' },
    { title: t('th_balance'), sub: importError ?? t('th_balance_sub'), tone: importError ? 'err' : 'ok' },
  ]

  async function buildModel(file: File) {
    if (file.size > THEATER_MAX_FILE_BYTES) return null
    try {
      const [{ parseSIEFile, detectEncoding, decodeBuffer }, { buildTheaterModel }] = await Promise.all([
        import('@/lib/import/sie-parser'),
        import('@/lib/import/theater-model'),
      ])
      const buffer = await file.arrayBuffer()
      const parsed = parseSIEFile(decodeBuffer(buffer, detectEncoding(buffer)))
      const m = buildTheaterModel(parsed)
      return {
        company: m.companyName || company || '',
        accounts: m.accounts.map((a) => ({ number: a.number, name: a.name, weight: a.weight })),
        counterparties: m.counterparties.map((c) => ({ name: c.name, account: c.account, weight: c.weight })),
      } satisfies TheaterModelInput
    } catch {
      return null
    }
  }

  async function runImport() {
    if (ordered.length === 0 || parsing) return
    setPhase('importing')
    setImportError(null)
    setTick(0)
    setWritten(0)
    setPrepared(0)
    setReg(null)
    setJobPhase('preparing')
    setOptsOpen(false)
    dispatch({ type: 'SET_WORKING', working: true })
    const m = (await buildModel(ordered[0].file)) ?? { company: company ?? '', accounts: [], counterparties: [] }
    setModel(m)
    at(300, () => setShown(1))
    at(1400, () => { setShown(2); apiRef.current?.spawnAccounts() })
    const voucherSeries = settings?.default_voucher_series || 'A'
    try {
      // Unmapped accounts get created from the file; the mapping then points them at themselves.
      if (unmapped.length > 0) {
        const res = await fetch('/api/import/sie/create-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: unmapped }),
        })
        if (!res.ok) throw new Error(getErrorMessage(await res.json().catch(() => ({}))))
        setCreated(unmapped.length)
        void invalidateReferenceData('ref:accounts')
      }
      await new Promise((r) => at(2400, () => r(null)))
      setShown(3)
      // Runs for as long as the job does; the count is held at what the
      // worker has actually written (setFeedCap), see ProviderStep.
      apiRef.current?.feedVouchers(15 * 60_000, Math.max(1, totalVouchers))
      apiRef.current?.setFeedCap(0)
      setJobPhase('preparing')
      let writtenSoFar = 0
      const importedAccounts: string[] = []
      for (let i = 0; i < ordered.length; i++) {
        setFileIdx(i)
        setPrepared(0)
        setJobPhase('preparing')
        const f = ordered[i]
        const p = f.parsed!
        const mappings = p.mappings.map((mp) => (mp.targetAccount ? mp : { ...mp, targetAccount: mp.sourceAccount, targetName: mp.sourceName, matchType: 'exact' as const, confidence: 1, isOverride: true }))
        const fd = new FormData()
        fd.append('file', f.file)
        fd.append('mappings', JSON.stringify(mappings))
        fd.append('options', JSON.stringify({
          createFiscalPeriod: true,
          importOpeningBalances: ib,
          importTransactions: true,
          updateAccountNames: namesOn,
          voucherSeries,
          openingBalanceSeries: defaultOpeningBalanceSeries([...(p.preview.voucherSeriesInFile ?? []), voucherSeries]),
          markImportedNoDocRequired: true,
        }))
        const res = await fetch('/api/import/sie/execute', { method: 'POST', body: fd })
        const data = await res.json().catch(() => ({}))
        // SIE import backbone (2026-09-11): execute admits a durable job and
        // answers 202 with its id; wait for the worker's terminal state. A
        // failed or paused job throws with the job's own message.
        const jobId = res.status === 202 ? (data?.data?.importId as string | undefined) : undefined
        const result = (jobId
          ? await waitForSIEJob(jobId, (job) => {
              const { written, phase } = jobProgress(job)
              setJobPhase(phase)
              setPrepared(job.prepared_through ?? 0)
              setTick(writtenSoFar + written)
              apiRef.current?.setFeedCap(Math.min(totalVouchers, writtenSoFar + written))
            })
          : (res.ok ? data.result : data?.error?.details?.result)) as { success?: boolean; journalEntriesCreated?: number; errors?: string[] } | undefined
        if (!res.ok && !result) throw new Error(getErrorMessage(data))
        if (!result?.success) throw new Error(result?.errors?.length ? result.errors.join(' ') : getErrorMessage(data))
        writtenSoFar += result.journalEntriesCreated ?? 0
        setWritten(writtenSoFar)
        setTick(writtenSoFar)
        for (const a of p.accounts) importedAccounts.push(a.number)
        void invalidateReferenceData(['ref:accounts', 'ref:fiscal-periods'])
      }
      setJobPhase(null)
      apiRef.current?.pulse()
      setTick(writtenSoFar)
      setShown(4)
      apiRef.current?.spawnCounterparties()
      await new Promise((r) => at(1300, () => r(null)))
      setShown(5)
      apiRef.current?.settle()
      dispatch({ type: 'IMPORTED', accounts: importedAccounts })
      void loadFindings()
      await new Promise((r) => at(900, () => r(null)))
      setPhase('imported')
      dispatch({ type: 'SET_WORKING', working: false })
      setReg(sieFirst ? 'card' : 'skipped')
    } catch (err) {
      setImportError(getErrorMessage(err, { locale }))
      setJobPhase(null)
      setShown(5)
      apiRef.current?.settle()
      setPhase('imported')
      dispatch({ type: 'SET_WORKING', working: false })
    }
  }

  /* ── registers: kunder, leverantörer, fakturor from the old system ── */
  const regLines: TheaterLine[] = [
    { title: t('reg_login', { provider: provName ?? t('reg_source') }), sub: t('reg_connected'), tone: 'ok' },
    { title: t('reg_customers'), sub: regCounts ? t('reg_count', { count: regCounts.customers }) : '' },
    { title: t('reg_suppliers'), sub: regCounts ? t('reg_count', { count: regCounts.suppliers }) : '' },
    { title: t('reg_invoices'), sub: regCounts ? t('reg_invoices_sub', { tick: regTick, total: regCounts.invoices }) : '' },
    { title: t('reg_link'), sub: regError ?? (regCounts ? t('reg_link_sub', { count: regCounts.linked }) : ''), tone: regError ? 'err' : 'ok' },
  ]

  const runRegisters = useCallback(async (cId: string) => {
    setReg('running')
    setRegError(null)
    setRegShown(1)
    dispatch({ type: 'SET_WORKING', working: true })
    try {
      const results = await providerMigrate(cId, { importCustomers: true, importSuppliers: true, importSalesInvoices: true, importSupplierInvoices: true, importAssets: false }, (_step, progress) => {
        setRegShown(progress < 20 ? 2 : progress < 40 ? 3 : progress < 90 ? 4 : 5)
      })
      const counts = {
        customers: results.customers?.imported ?? 0,
        suppliers: results.suppliers?.imported ?? 0,
        invoices: (results.salesInvoices?.imported ?? 0) + (results.supplierInvoices?.imported ?? 0),
        linked: (results.salesInvoices?.imported ?? 0) + (results.supplierInvoices?.imported ?? 0),
      }
      setRegCounts(counts)
      setRegShown(4)
      await new Promise<void>((resolve) => {
        const api = apiRef.current
        if (!api || counts.invoices === 0) { setRegTick(counts.invoices); resolve(); return }
        api.registerStage({
          source: provName ?? t('reg_source'),
          ms: Math.min(6000, Math.max(2200, counts.invoices * 25)),
          invoices: [['1510', results.salesInvoices?.imported ?? 0], ['2440', results.supplierInvoices?.imported ?? 0]],
          onProgress: (r) => { setRegTick(r.matched + r.review); if (r.done) resolve() },
        })
        at(8000, () => resolve())
      })
      setRegShown(5)
      if (results.stepErrors?.length) setRegError(results.stepErrors.map((e) => getErrorMessage(e, { locale })).join(' '))
      await providerAccept(cId)
      setReg('done')
      void loadFindings()
    } catch (err) {
      setRegError(getErrorMessage(err, { locale }))
      setRegShown(5)
      setReg('done')
    } finally {
      dispatch({ type: 'SET_WORKING', working: false })
    }
  }, [at, dispatch, loadFindings, locale, provName, t])

  useProviderMessage(
    (cId) => { setConsentId(cId); void runRegisters(cId) },
    (reason) => { setRegError(getErrorMessage(reason, { locale })); setReg('card') },
  )

  async function connectRegisters(providerId: string) {
    setRegError(null)
    setReg('connecting')
    const popup = openProviderWindow()
    try {
      const r = await providerConnect(providerId)
      setConsentId(r.consentId)
      if (r.alreadyConnected) { popup?.close(); void runRegisters(r.consentId); return }
      if (r.authType === 'oauth' && r.authUrl) { pointWindow(popup, r.authUrl); return }
      popup?.close()
      setReg('token')
    } catch (err) {
      popup?.close()
      setRegError(getErrorMessage(err, { locale }))
      setReg('card')
    }
  }

  async function submitToken() {
    if (!consentId || !regProvider) return
    setReg('connecting')
    try {
      await providerSubmitToken(consentId, regProvider, tokenA, tokenB)
      void runRegisters(consentId)
    } catch (err) {
      setRegError(getErrorMessage(err, { locale }))
      setReg('token')
    }
  }

  /* ── render ──────────────────────────────────────────────────────── */
  function onDrop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  const showDrop = phase === 'drop'
  const regBusy = reg === 'running'
  const canContinue = phase === 'imported' && !importError && (reg === 'done' || reg === 'skipped')

  return (
    <div className="bks-host">
      <div className="jny-qstep" style={{ textAlign: 'center' }}>
        <h1 className="jny-qtitle"><InkText text={t('sie_title')} /></h1>
        <p className="jny-qsub">{sieFirst ? t('sie_sub_first', { provider: provName ?? '' }) : t('sie_sub')}</p>
      </div>

      {showDrop ? (
        <>
          <input ref={inputRef} type="file" accept=".se,.sie" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
          {/* One input for every file's chart: chartForFile says which row
              opened it, so the picker never has to be rendered per row. */}
          <input
            ref={chartInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0]
              const target = chartForFile.current
              e.target.value = ''
              chartForFile.current = null
              if (picked && target) void applyChart(target, picked)
            }}
          />
          {files.length === 0 ? (
            <button
              type="button"
              className={`drop1${over ? ' is-over' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <p className="big">{t('sie_drop_title')}</p>
              <p className="s">{t('sie_drop_sub')}</p>
            </button>
          ) : (
            <div className="drop1 is-file" onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
              {files.map((f) => (
                <p key={f.id} className="file">
                  {f.file.name}
                  {f.status === 'parsing' ? <span className="bks-f" style={{ marginLeft: 8, color: 'hsl(var(--muted-foreground))' }}>{t('sie_reading')}</span> : null}
                  {f.status === 'dup' ? (
                    <span className="bks-f is-warn" style={{ marginLeft: 8 }}>
                      {f.error}{' '}
                      {f.dupImportId ? <button type="button" className="imp-change" onClick={() => void replaceDup(f.id)}>{t('sie_replace')}</button> : null}
                    </span>
                  ) : null}
                  {f.status === 'error' ? <span className="bks-f is-warn" style={{ marginLeft: 8 }}>{f.error}</span> : null}
                  {/* Chart first, then what it did to this year. Both belong
                      on the row and neither belongs in the facts line: the
                      counts do not add up across years. The same 47 accounts
                      recur in every chart, so a total of 267 would describe
                      roughly 47 accounts counted six times. A per-year count
                      is a fact; their sum is a number with no referent. */}
                  {f.status === 'ready' ? (
                    <>
                      <span style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          className="imp-change"
                          style={{ marginLeft: 8 }}
                          title={f.chart?.applied ? f.chart.name : undefined}
                          onClick={() => { chartForFile.current = f.id; chartInputRef.current?.click() }}
                        >
                          {f.chart?.applied
                            ? shortChartName(f.chart.name)
                            : f.chart ? t('sie_chart_unread') : t('sie_chart_pick')}
                        </button>
                        {f.chart?.applied ? (
                          <span className="bks-f" style={{ marginLeft: 6, color: 'hsl(var(--muted-foreground))' }}>
                            {t('sie_chart_count', { count: f.chart.treatments })}
                          </span>
                        ) : null}
                      </span>
                    </>
                  ) : null}
                </p>
              ))}
              {/* Why, and where to get one. Once, in the small sub-line the
                  surface already uses, and only while it is still an open
                  question: a reader who has picked their charts does not need
                  to be told what they are for. The menu path is the half that
                  decides whether the invitation can be acted on at all, and
                  the mapping step's own help carries the same sentence. */}
              {ready.length > 0 && ready.every((f) => !f.chart) ? (
                <p className="s" style={{ marginTop: 8 }}>
                  {t('sie_chart_why')}<br />{t('sie_chart_where')}
                </p>
              ) : null}
              {facts.length ? <Facts facts={facts} /> : null}
            </div>
          )}
          {ready.length > 0 ? (
            <>
              <Sentence open={optsOpen} onToggle={() => setOptsOpen((v) => !v)} changeLabel={t('change')} closeLabel={t('close')}>
                {t.rich('sie_sentence', { years: nYears, count: totalVouchers.toLocaleString('sv-SE'), ib: ib ? 'yes' : 'no', b: (c) => <b>{c}</b> })}
              </Sentence>
              {optsOpen ? (
                <OptRows>
                  <OptRow
                    name={t('opt_ib')}
                    desc={hasIb ? t('opt_ib_desc', { amount: ibAmount.toLocaleString('sv-SE') }) : t('opt_ib_none')}
                    off={!ib}
                    locked={!hasIb}
                    control={<Switch on={ib} onToggle={() => setIbOn(!ib)} label={t('opt_ib')} locked={!hasIb} />}
                  />
                  <OptRow
                    name={t('opt_names')}
                    desc={t('opt_names_desc')}
                    off={!namesOn}
                    control={<Switch on={namesOn} onToggle={() => setNamesOn((v) => !v)} label={t('opt_names')} />}
                  />
                </OptRows>
              ) : null}
            </>
          ) : null}
          <div className="jny-qactions">
            {files.length > 0 ? (
              <>
                <button type="button" className="jny-btn-quiet" onClick={() => { setFiles([]); setOptsOpen(false) }}>{t('sie_other_file')}</button>
                <button type="button" className="jny-btn-quiet" onClick={() => inputRef.current?.click()}>{t('sie_add_file')}</button>
              </>
            ) : null}
            {ready.length > 0 && !parsing ? (
              <button type="button" className="jny-btn" onClick={() => void runImport()}>{t('sie_import', { count: nYears })}</button>
            ) : null}
          </div>
        </>
      ) : null}

      {phase !== 'drop' ? (
        <Theater
          model={model}
          lines={regBusy || reg === 'done' ? regLines : lines}
          shown={regBusy || reg === 'done' ? regShown : shown}
          settled={phase === 'imported' && !regBusy}
          hold={phase === 'importing' ? t('sie_hold_open') : null}
          progress={regBusy || reg === 'done' ? undefined : {
            phase: importError ? 'failed' : phase === 'imported' ? 'complete' : jobPhase ?? 'checking',
            written: tick,
            total: totalVouchers,
            prepared,
            file: { current: fileIdx + 1, total: ordered.length },
          }}
          onApi={(api) => { apiRef.current = api }}
          groupLabels={{ tillgangar: t('grp_assets'), skulder: t('grp_liabilities'), intakter: t('grp_revenue'), kostnader: t('grp_costs') }}
          reviewLabel={t('grp_review')}
        />
      ) : null}
      {phase === 'imported' && !importError && sieFirst && reg === 'card' ? (
        <div className="reg" style={{ marginTop: 18 }}>
          <button type="button" className="drop1" onClick={() => state.provider && void connectRegisters(state.provider)}>
            <p className="big">{t('reg_card_title', { provider: provName ?? '' })}</p>
            <p className="s">{t('reg_card_sub')}</p>
          </button>
          {regError ? <p className="bks-err">{regError}</p> : null}
          <div className="jny-qactions"><button type="button" className="jny-btn-quiet" onClick={() => setReg('skipped')}>{t('reg_skip')}</button></div>
        </div>
      ) : null}
      {reg === 'connecting' ? <Wait text={t('reg_connecting', { provider: provName ?? '' })} height={96} /> : null}
      {reg === 'token' ? (
        <div className="tokfields">
          <input type="text" value={tokenB} onChange={(e) => setTokenB(e.target.value)} placeholder={t('tok_company', { provider: provName ?? '' })} />
          <input type="password" value={tokenA} onChange={(e) => setTokenA(e.target.value)} placeholder={t('tok_token', { provider: provName ?? '' })} autoComplete="off" />
          {regError ? <p className="bks-err">{regError}</p> : null}
          <div className="jny-qactions" style={{ marginTop: 12 }}>
            <button type="button" className="jny-btn-quiet" onClick={() => setReg('card')}>‹ {t('back')}</button>
            <button type="button" className="jny-btn" disabled={!tokenA} onClick={() => void submitToken()}>{t('tok_connect')}</button>
          </div>
        </div>
      ) : null}

      {canContinue ? (
        <div style={{ marginTop: 22 }}>
          <InsightPanel ctx={ctx} base={300} summary />
        </div>
      ) : null}

      {phase === 'imported' ? (
        <div className="jny-qactions">
          {canContinue ? (
            <button type="button" className="jny-btn" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
              {flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')}
            </button>
          ) : null}
          {importError ? (
            <>
              <button type="button" className="jny-btn-quiet" onClick={() => { setPhase('drop'); setFiles([]); setModel(null); setShown(0); setTick(0); setImportError(null) }}>{t('sie_other_file')}</button>
              {written > 0 ? (
                <button type="button" className="jny-btn" onClick={() => { dispatch({ type: 'IMPORTED' }); dispatch({ type: 'TO_INSIGHT' }) }}>{t('to_insight')}</button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
