/**
 * Byrå cockpit aggregation (WL-14): one overview row per client company.
 *
 * Read-first by design (WL-09): every query here is a cross-membership READ,
 * which RLS already allows via user_company_ids(); nothing writes. Queries
 * are GROUPED across all client company ids (a handful of queries total,
 * never N-per-company):
 *
 *   1. byrå team membership (teams.kind = 'byra')
 *   2. client companies (companies.team_id = byrå team)
 *   3. display names/org numbers (company_settings)
 *   4. unbooked transactions (canonical lib/worklist book_transaction predicate)
 *   5. unconsumed inbox documents (lib/worklist inbox_document predicate,
 *      including the document_attachments backstop)
 *   6. open deadlines (status-engine semantics)
 *   7. latest posted verifikat per company (embedded order+limit, one query)
 *
 * fetchAllRows guards every query that can exceed PostgREST's 1000-row cap.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  countByCompany,
  pickNextDeadlines,
  sortClientRows,
  type ClientOverviewRow,
  type DeadlineRowInput,
} from '@/lib/clients/aggregate'

export interface ClientOverview {
  team: { id: string; name: string }
  /** The caller's role in the byrå team: gates the create action (WL-15). */
  role: 'owner' | 'admin' | 'member'
  clients: ClientOverviewRow[]
}

/** Max ids per PostgREST .in() filter (mirrors lib/worklist IN_CLAUSE_CHUNK). */
const IN_CLAUSE_CHUNK = 150

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

interface ByraMembershipRow {
  team_id: string
  role: string
  teams: { id: string; name: string; kind: string } | null
}

/**
 * The caller's byrå team membership, or null for non-byrå users. When a user
 * somehow belongs to several byrå teams the earliest-created team wins
 * (deterministic, mirrors ensure_user_team's tie-break).
 */
export async function getByraMembership(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ teamId: string; teamName: string; role: ClientOverview['role'] } | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id, role, teams:team_id!inner(id, name, kind, created_at)')
    .eq('user_id', userId)
    .eq('teams.kind', 'byra')
    .order('created_at', { ascending: true })

  if (error || !data || data.length === 0) return null

  const row = data[0] as unknown as ByraMembershipRow
  const role = row.role === 'owner' || row.role === 'admin' ? row.role : 'member'
  return {
    teamId: row.team_id,
    teamName: row.teams?.name ?? '',
    role,
  }
}

/**
 * Aggregate the client overview for the caller's byrå team. Returns null when
 * the user is not a byrå team member (the route maps that to 403, the page to
 * a redirect).
 */
export async function fetchClientOverview(
  supabase: SupabaseClient,
  userId: string,
): Promise<ClientOverview | null> {
  const membership = await getByraMembership(supabase, userId)
  if (!membership) return null

  // 2. Client companies: everything hanging on the byrå team, archived
  // excluded. RLS additionally scopes this to companies the caller can read
  // (team sync makes every byrå member a member of every client company).
  const companies = await fetchAllRows<{
    id: string
    name: string
    org_number: string | null
  }>(({ from, to }) =>
    supabase
      .from('companies')
      .select('id, name, org_number')
      .eq('team_id', membership.teamId)
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  )

  if (companies.length === 0) {
    return {
      team: { id: membership.teamId, name: membership.teamName },
      role: membership.role,
      clients: [],
    }
  }

  const companyIds = companies.map((c) => c.id)
  const idChunks = chunked(companyIds, IN_CLAUSE_CHUNK)

  // 3. Current display names + settings org numbers (companies.name can be
  // stale; the dashboard layout uses the same source).
  const settingsRows: Array<{
    company_id: string
    company_name: string | null
    org_number: string | null
  }> = []
  for (const chunk of idChunks) {
    const { data, error } = await supabase
      .from('company_settings')
      .select('company_id, company_name, org_number')
      .in('company_id', chunk)
    if (error) throw new Error(error.message)
    settingsRows.push(...(data ?? []))
  }
  const settingsByCompany = new Map(settingsRows.map((s) => [s.company_id, s]))

  // 4. Unbooked transactions: the canonical predicate (is_business IS NULL
  // AND is_ignored = false; see lib/worklist/types.ts book_transaction).
  const unbookedRows: Array<{ company_id: string }> = []
  for (const chunk of idChunks) {
    const rows = await fetchAllRows<{ id: string; company_id: string }>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id, company_id')
        .in('company_id', chunk)
        .is('is_business', null)
        .eq('is_ignored', false)
        .order('id', { ascending: true })
        .range(from, to),
    )
    unbookedRows.push(...rows)
  }
  const unbookedByCompany = countByCompany(unbookedRows)

  // 5. Unconsumed inbox documents (lib/worklist inbox_document): items with a
  // file that became nothing yet, whose document is still unlinked.
  const inboxRows: Array<{ company_id: string; document_id: string | null }> = []
  for (const chunk of idChunks) {
    const rows = await fetchAllRows<{
      id: string
      company_id: string
      document_id: string | null
    }>(({ from, to }) =>
      supabase
        .from('invoice_inbox_items')
        .select('id, company_id, document_id')
        .in('company_id', chunk)
        .not('document_id', 'is', null)
        .is('created_supplier_invoice_id', null)
        .is('created_journal_entry_id', null)
        .is('matched_transaction_id', null)
        .order('id', { ascending: true })
        .range(from, to),
    )
    inboxRows.push(...rows)
  }

  const docIds = [
    ...new Set(inboxRows.map((r) => r.document_id).filter((id): id is string => !!id)),
  ]
  const unlinkedDocRows: Array<{ company_id: string }> = []
  for (const chunk of chunked(docIds, IN_CLAUSE_CHUNK)) {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, company_id')
      .in('id', chunk)
      .is('journal_entry_id', null)
      .eq('is_current_version', true)
    if (error) throw new Error(error.message)
    unlinkedDocRows.push(...(data ?? []))
  }
  const inboxByCompany = countByCompany(unlinkedDocRows)

  // 6. Open deadlines across all clients, then the earliest per company with
  // the 14-day ACTION_NEEDED semantics (lib/deadlines/status-engine.ts).
  const deadlineRows: DeadlineRowInput[] = []
  for (const chunk of idChunks) {
    const rows = await fetchAllRows<DeadlineRowInput & { id: string }>(({ from, to }) =>
      supabase
        .from('deadlines')
        .select('id, company_id, title, due_date, tax_deadline_type, status')
        .in('company_id', chunk)
        .eq('is_completed', false)
        .is('dismissed_at', null)
        .in('status', ['upcoming', 'action_needed', 'in_progress', 'overdue'])
        .order('id', { ascending: true })
        .range(from, to),
    )
    deadlineRows.push(...rows)
  }
  const nextDeadlineByCompany = pickNextDeadlines(deadlineRows)

  // 7. Latest posted verifikat date per company: ONE query using PostgREST's
  // per-parent embedded order + limit (lateral join under the hood), instead
  // of N latest-entry queries.
  const lastBookedByCompany = new Map<string, string>()
  for (const chunk of idChunks) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, journal_entries(entry_date)')
      .in('id', chunk)
      .eq('journal_entries.status', 'posted')
      .order('entry_date', { referencedTable: 'journal_entries', ascending: false })
      .limit(1, { referencedTable: 'journal_entries' })
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as Array<{
      id: string
      journal_entries: Array<{ entry_date: string }> | null
    }>) {
      const entryDate = row.journal_entries?.[0]?.entry_date
      if (entryDate) lastBookedByCompany.set(row.id, entryDate)
    }
  }

  const clients: ClientOverviewRow[] = companies.map((company) => {
    const settings = settingsByCompany.get(company.id)
    return {
      companyId: company.id,
      name: settings?.company_name || company.name,
      orgNumber: company.org_number ?? settings?.org_number ?? null,
      unbookedCount: unbookedByCompany.get(company.id) ?? 0,
      inboxCount: inboxByCompany.get(company.id) ?? 0,
      nextDeadline: nextDeadlineByCompany.get(company.id) ?? null,
      lastBookedDate: lastBookedByCompany.get(company.id) ?? null,
    }
  })

  return {
    team: { id: membership.teamId, name: membership.teamName },
    role: membership.role,
    clients: sortClientRows(clients),
  }
}
