'use client'

import { waitForSIEJob } from '@/lib/import/sie-job-client'
import type { SIEJob } from '@/lib/import/sie-job-contract'
import type { RefObject } from 'react'
import { useOAuthPopup } from '@/lib/hooks/use-oauth-popup'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { ProviderPreviewCounts } from '@/lib/providers/preview-counts'
import type { TheaterModel } from '@/lib/import/theater-model'
import type { SIEAccount } from '@/lib/import/types'
import type { ProviderFileStatus } from '@/lib/onboarding-books/provider-years'
import type { MigrationResource, ProviderMigrationStatus } from '@/lib/providers/migration-contract'

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
  /** Counts over the default years the preview read; shown via previewCountsForSelection. */
  sieStats: ProviderPreviewCounts | null
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
  /** Every account across the selected years. */
  accounts: SIEAccount[]
  /** Built on the server over every selected year. */
  theater: TheaterModel
  mappings: ProviderMapping[]
  mappingStats: { total: number; mapped: number; unmapped: number }
  /** One per fetched file, oldest first: where /sie-data archived it. previousImport: a completed import already holds that year. */
  fileStatuses: ProviderFileStatus[]
  /** Selected years the provider did not hand over. */
  failedYears?: { year: number; error: string }[]
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

/** The file goes by the path /sie-data archived it under, never as content. */
export async function providerImportSie(file: Pick<ProviderFileStatus, 'storagePath' | 'filename'>, mappings: ProviderMapping[], voucherSeries: string | null, onProgress?: (job: SIEJob) => void): Promise<SieImportOutcome> {
  const res = await fetch(`${ARCIM}/import-sie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storagePath: file.storagePath,
      filename: file.filename,
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

/** Every resource's imported and total records, summed. */
function registerCounts(status: ProviderMigrationStatus): { imported: number; total: number } {
  return status.counts.reduce((sum, row) => ({ imported: sum.imported + row.imported, total: sum.total + row.total }),
    { imported: 0, total: 0 })
}

function registerResults(status: ProviderMigrationStatus): MigrateResults {
  const results: MigrateResults = {}
  for (const row of status.counts) results[row.resource] = { imported: row.imported, total: row.total, skipped: row.skipped }
  return results
}

/**
 * The customer, supplier and invoice registers through the background import
 * job, as the Import page runs them. They went through /migrate, which read
 * each Fortnox customer's and supplier's own record for at most 90 seconds
 * and saved everyone it did not reach from the short list: no type, no
 * active flag, no VAT number, country or terms, so a privatperson became a
 * company (crm#1436). The job reads every record in full however large the
 * register. Waits for the job's outcome so the step keeps its one-call
 * contract, as providerImportSie waits for the SIE job.
 */
export async function providerImportRegisters(
  consentId: string,
  resources: MigrationResource[],
  onProgress: (imported: number, total: number) => void,
): Promise<MigrateResults> {
  const jobs = `${ARCIM}/migration-jobs`
  const res = await fetch(jobs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentId, resources }) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(json, `HTTP ${res.status}`)
  const jobId = (json as { data: { jobId: string } }).data.jobId
  let lastNudge = Date.now()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const statusRes = await fetch(`${jobs}?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
    // A missed poll is no outcome: the job runs on regardless.
    if (!statusRes.ok) continue
    const status = ((await statusRes.json()) as { data: ProviderMigrationStatus }).data
    const { imported, total } = registerCounts(status)
    onProgress(imported, total)
    if (status.job.state === 'completed') return registerResults(status)
    if (status.job.state === 'needs_attention') {
      // Every record has an outcome: the import is done, and the few that
      // need a look stay listed on the Import page.
      if (status.review.acceptable) return registerResults(status)
      const code = status.job.error_code ?? 'PROVIDER_MIGRATE_FAILED'
      throw fail({ error: { code } }, code)
    }
    // The cron runs the job; a nudge makes it start sooner, as the Import page does.
    if (Date.now() - lastNudge > 30_000) {
      lastNudge = Date.now()
      void fetch(`${jobs}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) })
        .catch(() => { /* A nudge only hurries the cron: a failed one leaves the job to it. */ })
    }
  }
}

/**
 * POST /migrate as an NDJSON stream; progress arrives per orchestrator event.
 * The asset register only: the registers run as a background job
 * (providerImportRegisters).
 */
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

/**
 * Listen for the provider popup's message. Put the window openProviderWindow
 * returned in the returned ref: only that window's messages are heard.
 * `cancelled`: the customer pressed cancel at the provider (access_denied).
 */
export function useProviderMessage(
  onSuccess: (consentId: string) => void,
  onError: (reason: string, cancelled: boolean) => void,
): RefObject<Window | null> {
  return useOAuthPopup<{ type?: string; consentId?: string; reason?: string; cancelled?: unknown }>((data) => {
    if (data?.type === 'arcim-oauth-success' && data.consentId) onSuccess(data.consentId)
    else if (data?.type === 'arcim-oauth-error') onError(typeof data.reason === 'string' && data.reason ? data.reason : 'OAuth', data.cancelled === true)
  })
}

/** The consentId a full-page provider return carried in the URL, stripped once read. */
export function takeReturnedConsentId(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const status = url.searchParams.get('migration')
  const consentId = url.searchParams.get('consentId')
  if (!consentId) return null
  for (const k of ['migration', 'consentId', 'handoff', 'reason', 'station', 'provider']) url.searchParams.delete(k)
  // Keep the entry's state: it carries the act's place for Tillbaka.
  window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : ''))
  return status === 'error' ? null : consentId
}
