'use client'

import { waitForSIEJob } from '@/lib/import/sie-job-client'
import type { SIEJob } from '@/lib/import/sie-job-contract'
import { useEffect, useRef } from 'react'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * The provider migration routes as the books act calls them. Same
 * endpoints and payloads as the Import page's workspace; only the surface
 * differs. Core must not import from @/extensions, so the shapes are
 * mirrored here.
 */

const ARCIM = '/api/extensions/ext/arcim-migration'

export interface ConnectResult {
  consentId: string
  authType: 'oauth' | 'token'
  authUrl?: string
  activationUrl?: string | null
  alreadyConnected?: boolean
}

export interface SourceFiscalYear {
  year: number
  fromDate: string | null
  toDate: string | null
  inDefaultSelection: boolean
}

export interface ProviderPreview {
  consent: { id: string; provider: string; status: number; companyName?: string }
  companyInfo: { company_name: string | null; org_number: string | null } | null
  sieAvailable: boolean
  sieStats: { accountCount: number; transactionCount: number; fiscalYears: number[] } | null
  sourceYears?: SourceFiscalYear[]
  maxSelectedYears?: number
  hasSieData: boolean
}

export interface ProviderMapping {
  sourceAccount: string
  sourceName: string
  targetAccount: string
  targetName: string
  confidence: number
  matchType: string
  isOverride: boolean
}

export interface ProviderSieData {
  parsed: { accounts: { number: string; name: string }[]; header?: { companyName?: string | null } }
  mappings: ProviderMapping[]
  mappingStats: { total: number; mapped: number; unmapped: number }
  rawContent: string[]
  fileStatuses?: { fiscalYear: number }[]
  allImported: boolean
}

export interface MigrateStep {
  imported?: number
  total?: number
  skipped?: number
}

export interface MigrateResults {
  customers?: MigrateStep
  suppliers?: MigrateStep
  salesInvoices?: MigrateStep
  supplierInvoices?: MigrateStep
  reconciliation?: { autoLinked?: number; unmatched?: number }
  stepErrors?: { step: string; code: string; message: string }[]
}

export interface MigrateOptions {
  importCustomers: boolean
  importSuppliers: boolean
  importSalesInvoices: boolean
  importSupplierInvoices: boolean
  importAssets: boolean
}

function fail(json: unknown, fallback: string): Error {
  const msg = getErrorMessage(json, {})
  return new Error(msg && msg !== 'Ett fel uppstod' ? msg : fallback)
}

export async function providerConnect(provider: string): Promise<ConnectResult> {
  const res = await fetch(`${ARCIM}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) })
  const json = (await res.json().catch(() => ({}))) as Partial<ConnectResult>
  if (!res.ok || !json.consentId) throw fail(json, `HTTP ${res.status}`)
  return json as ConnectResult
}

export async function providerSubmitToken(consentId: string, provider: string, apiToken: string, companyId: string): Promise<void> {
  const res = await fetch(`${ARCIM}/submit-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consentId, provider, apiToken, companyId: companyId || undefined }),
  })
  if (!res.ok) throw fail(await res.json().catch(() => ({})), `HTTP ${res.status}`)
}

export async function providerPreview(consentId: string): Promise<ProviderPreview> {
  const res = await fetch(`${ARCIM}/preview?consentId=${encodeURIComponent(consentId)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(json, `HTTP ${res.status}`)
  return json as ProviderPreview
}

export async function providerSieData(consentId: string, years: number[]): Promise<ProviderSieData> {
  const q = years.length ? `&years=${years.join(',')}` : ''
  const res = await fetch(`${ARCIM}/sie-data?consentId=${encodeURIComponent(consentId)}${q}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(json, `HTTP ${res.status}`)
  return json as ProviderSieData
}

export interface SieImportOutcome {
  success: boolean
  journalEntriesCreated: number
  errors: string[]
  warnings: string[]
}

export async function providerImportSie(rawContent: string, mappings: ProviderMapping[], voucherSeries: string | null, onProgress?: (job: SIEJob) => void): Promise<SieImportOutcome> {
  const res = await fetch(`${ARCIM}/import-sie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawContent,
      mappings,
      options: { createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true, voucherSeries: voucherSeries ?? undefined, updateAccountNames: true },
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(json, `HTTP ${res.status}`)
  // SIE import backbone (2026-09-11): the handler admits a durable job and
  // answers 202 with its id; the ledger is written by the worker. Wait for
  // the terminal state here so the step keeps its one-call contract. A
  // failed or paused job throws with the job's own message.
  if (res.status === 202 && typeof json.importId === 'string') {
    const result = await waitForSIEJob(json.importId, onProgress)
    return {
      success: result.success,
      journalEntriesCreated: result.journalEntriesCreated ?? 0,
      errors: result.errors ?? [],
      warnings: result.warnings ?? [],
    }
  }
  return json as SieImportOutcome
}

/** POST /migrate as an NDJSON stream; progress arrives per orchestrator event. */
export async function providerMigrate(
  consentId: string,
  opts: MigrateOptions,
  onProgress: (step: string | undefined, progress: number) => void,
): Promise<MigrateResults> {
  const res = await fetch(`${ARCIM}/migrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ consentId, importCompanyInfo: false, ...opts }),
  })
  if (!res.ok) throw fail(await res.json().catch(() => ({})), `HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/x-ndjson') || !res.body) {
    const json = (await res.json()) as { results?: MigrateResults }
    return json.results ?? {}
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let results: MigrateResults = {}
  const handle = (line: string) => {
    if (!line.trim()) return
    let ev: { kind?: string; currentStep?: string; progress?: number; results?: MigrateResults }
    try { ev = JSON.parse(line) } catch { return }
    if (ev.kind === 'progress' && typeof ev.progress === 'number') onProgress(ev.currentStep || undefined, ev.progress)
    else if (ev.kind === 'done') results = ev.results ?? {}
    else if (ev.kind === 'error') throw fail(ev, 'Migreringen misslyckades.')
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) handle(l)
    }
    buffer += decoder.decode()
    if (buffer) handle(buffer)
  } finally {
    reader.releaseLock()
  }
  return results
}

export async function providerAccept(consentId: string): Promise<void> {
  await fetch(`${ARCIM}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentId }) }).catch(() => {})
}

/**
 * Open the provider's login in a popup. The callback page posts
 * arcim-oauth-success with the consentId and closes itself; with no
 * opener it redirects to /import?migration=connected&consentId=..., which
 * the gate rewrites onto this act. Open the window inside the click and
 * point it afterwards, or the browser blocks it.
 */
export function openProviderWindow(): Window | null {
  const w = 600, h = 700
  const left = window.screenX + (window.outerWidth - w) / 2
  const top = window.screenY + (window.outerHeight - h) / 2
  return window.open('', 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)
}

export function pointWindow(popup: Window | null, url: string) {
  if (popup && !popup.closed) popup.location.href = url
  else window.location.href = url
}

/** Listen for the provider popup's message. */
export function useProviderMessage(onSuccess: (consentId: string) => void, onError: (reason: string) => void) {
  const okRef = useRef(onSuccess)
  const errRef = useRef(onError)
  useEffect(() => {
    okRef.current = onSuccess
    errRef.current = onError
  })
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: string; consentId?: string; reason?: string } | null
      if (data?.type === 'arcim-oauth-success' && data.consentId) okRef.current(data.consentId)
      else if (data?.type === 'arcim-oauth-error') errRef.current(typeof data.reason === 'string' && data.reason ? data.reason : 'OAuth')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
}

/** The consentId a full-page provider return carried in the URL, stripped once read. */
export function takeReturnedConsentId(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const status = url.searchParams.get('migration')
  const consentId = url.searchParams.get('consentId')
  if (!consentId) return null
  for (const k of ['migration', 'consentId', 'handoff', 'reason', 'station', 'provider']) url.searchParams.delete(k)
  window.history.replaceState({}, '', url.pathname + (url.search ? url.search : ''))
  return status === 'error' ? null : consentId
}
