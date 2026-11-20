import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'

/**
 * The export window for a deleted company (terms v2, point 9.3).
 *
 * Deleting a company archives it (POST /api/company/[id]/delete): it is
 * hidden at once, because every read goes through user_company_ids(), which
 * leaves archived companies out. For the months below, the people who could
 * download its full archive before (owners and admins, as in
 * GET /api/reports/full-archive) can still download it from Säkerhet, read
 * only. After that the window closes and nobody reaches the company any more:
 * its accounting records stay sealed in the database, never deleted here
 * (BFL 7 kap. 2 §; the triggers of migration 017 forbid it anyway), until a
 * later job removes them when the archiving period has run out.
 *
 * This is a sanctioned exception to company-archived-access (an archived
 * company is out of reach for every caller, lib/company/company-access.ts),
 * like the migration-reset archive: read only, owners and admins, a session
 * route only (never an API key or MCP), and only for 18 months. The retained
 * source of a migration reset is left out: it was replaced, not deleted, and
 * its archive has its own route (/api/company/[id]/migration-reset/archive).
 *
 * Every read here uses the service client: RLS hides archived companies from
 * the person's own client by design, so each function re-checks membership
 * itself. Callers pass the signed-in user's id, never one from the request.
 */

/** How long after the deletion the archive can be downloaded, in calendar months. */
export const DELETED_COMPANY_EXPORT_MONTHS = 18

/** Roles that may download a company's full archive (same as /api/reports/full-archive). */
const EXPORT_ROLES = ['owner', 'admin'] as const

export interface DeletedCompanyExport {
  id: string
  name: string
  /** When the company was deleted (companies.archived_at), ISO timestamp. */
  archivedAt: string
  /** The last Swedish calendar day the archive can be downloaded, YYYY-MM-DD. */
  exportUntil: string
}

/**
 * The last day of the window: the Swedish calendar day of the deletion plus
 * 18 months, clamped to the month's last day (2026-08-31 gives 2028-02-29).
 */
export function exportWindowEndsOn(archivedAt: string): string {
  return addMonthsIso(todayIsoStockholm(new Date(archivedAt)), DELETED_COMPANY_EXPORT_MONTHS)
}

/** True while the archive can still be downloaded: up to and including exportWindowEndsOn. */
export function isExportWindowOpen(archivedAt: string, now: Date = new Date()): boolean {
  return todayIsoStockholm(now) <= exportWindowEndsOn(archivedAt)
}

interface MembershipWithCompany {
  role: string
  companies: { id: string; name: string | null; archived_at: string | null } | null
}

/** Of these archived companies, the ones that are the retained source of a migration reset. */
async function readResetSources(service: SupabaseClient, companyIds: string[]): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set()
  const { data, error } = await service
    .from('company_migration_resets')
    .select('source_company_id')
    .in('source_company_id', companyIds)
  if (error) throw new Error(`Failed to read migration reset sources: ${error.message}`)
  return new Set(((data ?? []) as Array<{ source_company_id: string }>).map((r) => r.source_company_id))
}

/** The name the UI showed for the company: company_settings.company_name, else companies.name. */
async function readDisplayNames(service: SupabaseClient, companyIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (companyIds.length === 0) return names
  const { data, error } = await service
    .from('company_settings')
    .select('company_id, company_name')
    .in('company_id', companyIds)
  if (error) throw new Error(`Failed to read deleted company names: ${error.message}`)
  for (const row of (data ?? []) as Array<{ company_id: string; company_name: string | null }>) {
    if (row.company_name?.trim()) names.set(row.company_id, row.company_name.trim())
  }
  return names
}

/**
 * The deleted companies this person may still download, newest deletion
 * first. Companies whose window has closed are left out. Throws on a failed
 * read.
 */
export async function listDeletedCompanyExports(
  service: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<DeletedCompanyExport[]> {
  // One query from the person's memberships: a byrå consultant can belong to
  // hundreds of companies, and only the archived ones come back.
  const { data, error } = await service
    .from('company_members')
    .select('role, companies!inner(id, name, archived_at)')
    .eq('user_id', userId)
    .in('role', EXPORT_ROLES as unknown as string[])
    .not('companies.archived_at', 'is', null)
  if (error) throw new Error(`Failed to list deleted companies: ${error.message}`)

  const inWindow = ((data ?? []) as unknown as MembershipWithCompany[])
    .map((row) => row.companies)
    .filter((c): c is { id: string; name: string | null; archived_at: string } => !!c?.archived_at)
    .filter((c) => isExportWindowOpen(c.archived_at, now))
  const resetSources = await readResetSources(
    service,
    inWindow.map((c) => c.id),
  )
  const open = inWindow.filter((c) => !resetSources.has(c.id))

  const names = await readDisplayNames(
    service,
    open.map((c) => c.id),
  )
  return open
    .map((c) => ({
      id: c.id,
      name: names.get(c.id) ?? c.name ?? '',
      archivedAt: c.archived_at,
      exportUntil: exportWindowEndsOn(c.archived_at),
    }))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
}

export type DeletedCompanyExportAccess =
  | { ok: true; company: DeletedCompanyExport }
  /** No owner/admin membership, not deleted, or a migration reset's source: answered as not found, so nothing leaks. */
  | { ok: false; reason: 'not_found' }
  /** A deleted company this person could export, but the window has closed. */
  | { ok: false; reason: 'window_closed'; exportUntil: string }

/** Whether this person may download the archive of this deleted company now. Throws on a failed read. */
export async function authorizeDeletedCompanyExport(
  service: SupabaseClient,
  userId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<DeletedCompanyExportAccess> {
  const { data, error } = await service
    .from('company_members')
    .select('role, companies!inner(id, name, archived_at)')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to authorize deleted company export: ${error.message}`)

  const row = data as unknown as MembershipWithCompany | null
  const company = row?.companies
  if (!row || !company?.archived_at || !(EXPORT_ROLES as readonly string[]).includes(row.role)) {
    return { ok: false, reason: 'not_found' }
  }
  if ((await readResetSources(service, [company.id])).has(company.id)) {
    return { ok: false, reason: 'not_found' }
  }
  const exportUntil = exportWindowEndsOn(company.archived_at)
  if (!isExportWindowOpen(company.archived_at, now)) {
    return { ok: false, reason: 'window_closed', exportUntil }
  }
  const names = await readDisplayNames(service, [company.id])
  return {
    ok: true,
    company: {
      id: company.id,
      name: names.get(company.id) ?? company.name ?? '',
      archivedAt: company.archived_at,
      exportUntil,
    },
  }
}
