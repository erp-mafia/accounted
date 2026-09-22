import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { buildCompanyGraph, GRAPH_VERSION } from './build'
import type { CompanyGraph } from './types'

/**
 * One snapshot per company, so the page and the agent read the same picture
 * at the same instant and serving it costs one row. The nightly lint rebuilds
 * it; the pipeline marks it stale when a document lands; a read older than
 * MAX_AGE_HOURS, marked stale, or drawn by an older builder, rebuilds on the
 * way out.
 */
const log = createLogger('arkiv/graph')
export const MAX_AGE_HOURS = 24

interface SnapshotRow {
  graph: CompanyGraph
  computed_at: string
  stale: boolean
}

export async function refreshCompanyGraph(supabase: SupabaseClient, companyId: string, today = new Date().toISOString().slice(0, 10)): Promise<CompanyGraph> {
  const graph = await buildCompanyGraph(supabase, companyId, today)
  const { error } = await supabase
    .from('arkiv_graph_snapshots')
    .upsert({ company_id: companyId, graph, node_count: graph.nodes.length, link_count: graph.links.length, computed_at: graph.computed_at, stale: false }, { onConflict: 'company_id' })
  if (error) log.warn('graph snapshot not saved', { companyId, reason: error.message })
  return graph
}

export async function getCompanyGraph(supabase: SupabaseClient, companyId: string, opts: { maxAgeHours?: number; today?: string } = {}): Promise<CompanyGraph> {
  const { data, error } = await supabase.from('arkiv_graph_snapshots').select('graph, computed_at, stale').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`graph snapshot fetch failed: ${error.message}`)
  const row = data as SnapshotRow | null
  const maxAge = (opts.maxAgeHours ?? MAX_AGE_HOURS) * 3600 * 1000
  const fresh = row && !row.stale && row.graph?.version === GRAPH_VERSION && Date.now() - new Date(row.computed_at).getTime() < maxAge
  if (fresh) return row.graph
  return refreshCompanyGraph(supabase, companyId, opts.today)
}

/** A document landed or a derivation ran: the next read rebuilds. Never throws. */
export async function markCompanyGraphStale(supabase: SupabaseClient, companyId: string): Promise<void> {
  try {
    const { error } = await supabase.from('arkiv_graph_snapshots').update({ stale: true }).eq('company_id', companyId)
    if (error) log.warn('graph snapshot not marked stale', { companyId, reason: error.message })
  } catch (err) {
    log.warn('graph snapshot not marked stale', { companyId, reason: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The nightly pass: rebuild the snapshots that are missing or stale, oldest
 * first, up to a budget. Reads rebuild lazily anyway; this keeps the first
 * read of the day fast.
 */
export async function refreshStaleGraphs(supabase: SupabaseClient, companyIds: string[], limit: number, today = new Date().toISOString().slice(0, 10)): Promise<{ refreshed: number; failed: number }> {
  if (companyIds.length === 0) return { refreshed: 0, failed: 0 }
  const { data, error } = await supabase.from('arkiv_graph_snapshots').select('company_id, stale, computed_at').in('company_id', companyIds)
  if (error) throw new Error(`graph snapshot list failed: ${error.message}`)
  const rows = new Map(((data ?? []) as Array<{ company_id: string; stale: boolean; computed_at: string }>).map((r) => [r.company_id, r]))
  const due = companyIds
    .filter((id) => { const r = rows.get(id); return !r || r.stale || Date.now() - new Date(r.computed_at).getTime() > MAX_AGE_HOURS * 3600 * 1000 })
    .sort((a, b) => new Date(rows.get(a)?.computed_at ?? 0).getTime() - new Date(rows.get(b)?.computed_at ?? 0).getTime())
    .slice(0, limit)
  let refreshed = 0
  let failed = 0
  for (const id of due) {
    try {
      await refreshCompanyGraph(supabase, id, today)
      refreshed++
    } catch (err) {
      failed++
      log.warn('graph rebuild failed', { companyId: id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { refreshed, failed }
}
