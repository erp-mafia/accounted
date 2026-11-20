/**
 * One run of the vendor-logo cron: queue the domains the last year's
 * vendors name, then fetch the ones that are due, a few at a time. Service
 * role only. Returns counts; nothing it logs names a company or a vendor.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { collectCandidateDomains, type CollectCounts } from './collect'
import { isExcludedDomain } from './excluded'
import { fetchVendorIcon, type FetchOutcome } from './fetch'
import { LOGO_BUCKET, nextState, storagePathFor, type VendorLogoRow, type VendorLogoUpdate } from './schedule'

export const FETCH_LIMIT = 50
export const FETCH_CONCURRENCY = 4
/** Stop starting new domains after this long, well inside the route's maxDuration. */
export const RUN_BUDGET_MS = 240_000
const INSERT_CHUNK = 500

export interface RunSummary {
  collected: number
  queued: number
  read: CollectCounts | null
  due: number
  found: number
  missing: number
  blocked: number
  excluded: number
  retry: number
  failed: number
  deferred: number
}

export interface RunOptions {
  collect: boolean
  limit?: number
  concurrency?: number
  budgetMs?: number
  fetchIcon?: (domain: string) => Promise<FetchOutcome>
  now?: () => Date
}

/** Queue domains the table does not hold yet; known rows are left alone. Returns how many were sent. */
export async function queueDomains(service: SupabaseClient, domains: Iterable<string>): Promise<number> {
  const rows = [...domains].filter((d) => !isExcludedDomain(d)).map((domain) => ({ domain }))
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error } = await service
      .from('vendor_logos')
      .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: 'domain', ignoreDuplicates: true })
    if (error) throw new Error('vendor_logos queue failed')
  }
  return rows.length
}

/** Write a row's next state. Keys left undefined (a kept icon's file) are not sent, so not changed. */
function writeState(service: SupabaseClient, domain: string, u: VendorLogoUpdate) {
  return service
    .from('vendor_logos')
    .update({
      status: u.status,
      storage_path: u.storage_path,
      source: u.source,
      width: u.width,
      sha256: u.sha256,
      attempts: u.attempts,
      fetched_at: u.fetched_at,
      next_attempt_at: u.next_attempt_at,
    })
    .eq('domain', domain)
}

/** Run `work` over `items`, at most `concurrency` at a time. */
async function pool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await work(item)
    }
  })
  await Promise.all(workers)
}

export async function runVendorLogos(service: SupabaseClient, opts: RunOptions): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date())
  const started = now().getTime()
  const fetchIcon = opts.fetchIcon ?? ((domain: string) => fetchVendorIcon(domain))
  const summary: RunSummary = {
    collected: 0, queued: 0, read: null, due: 0, found: 0, missing: 0, blocked: 0, excluded: 0, retry: 0, failed: 0, deferred: 0,
  }

  if (opts.collect) {
    const { domains, counts } = await collectCandidateDomains(service, now())
    summary.collected = domains.size
    summary.read = counts
    summary.queued = await queueDomains(service, domains)
  }

  const { data, error } = await service
    .from('vendor_logos')
    .select('domain, status, attempts')
    .lte('next_attempt_at', now().toISOString())
    .order('next_attempt_at', { ascending: true })
    .order('domain', { ascending: true })
    .limit(opts.limit ?? FETCH_LIMIT)
  if (error) throw new Error('vendor_logos due read failed')
  const due = (data ?? []) as VendorLogoRow[]
  summary.due = due.length

  await pool(due, opts.concurrency ?? FETCH_CONCURRENCY, async (row) => {
    if (now().getTime() - started > (opts.budgetMs ?? RUN_BUDGET_MS)) {
      summary.deferred++
      return
    }
    try {
      const outcome: FetchOutcome = isExcludedDomain(row.domain) ? { status: 'excluded' } : await fetchIcon(row.domain)
      if (outcome.status === 'found') {
        const { error: uploadError } = await service.storage
          .from(LOGO_BUCKET)
          .upload(storagePathFor(outcome.icon.sha256), outcome.icon.png, {
            contentType: 'image/png',
            upsert: true,
            // Content-addressed: a path never changes its bytes.
            cacheControl: '31536000',
          })
        if (uploadError) throw new Error('upload failed')
      }
      const { error: updateError } = await writeState(service, row.domain, nextState(row, outcome, now()))
      if (updateError) throw new Error('update failed')
      summary[outcome.status]++
    } catch {
      // Our side failed (storage, the database): count it as an attempt so the row waits a day.
      summary.failed++
      await writeState(service, row.domain, nextState(row, { status: 'retry', reason: 'internal' }, now())).then(
          () => undefined,
          () => undefined,
        )
    }
  })

  return summary
}
