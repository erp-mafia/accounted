import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { loadPacks, packToLibraryRow, type LoadedPack } from './load'

const log = createLogger('packs-sync')

/**
 * Reconcile the system booking templates in the database with `packs/*.yaml`.
 *
 * The packs are the source of truth; the table is the query surface. Keeping
 * the rows means the existing read path (one query returning system + company +
 * team templates under RLS) is untouched, and every template id stays stable.
 *
 * ## Why upsert on pack_slug, not name
 *
 * `booking_template_usage.template_id` is `ON DELETE CASCADE`. Matching on name
 * would mean a corrected Swedish label looks like a new template, and the old
 * row's deletion would silently wipe every company's "recently used" history
 * for it. `pack_slug` is the stable identity (migration 20260803230000).
 *
 * ## Why retire instead of delete
 *
 * Same cascade. A pack removed from the catalogue deactivates its row rather
 * than dropping it: the read path already filters `is_active`, so it disappears
 * from the picker, but usage history and any audit trail survive. Deletion is
 * never automatic here.
 *
 * ## Fail closed on a broken catalogue
 *
 * If any pack fails to parse or validate, nothing is written at all. A partial
 * sync driven by a half-readable catalogue is worse than a stale one: the
 * database would end up in a state no commit of the repo describes.
 */

export interface PackSyncResult {
  /** Slugs inserted as new system templates. */
  inserted: string[]
  /** Slugs whose row content changed. */
  updated: string[]
  /** Slugs already in sync. */
  unchanged: string[]
  /** Slugs deactivated because their pack is gone. */
  retired: string[]
  /** Load/validation errors. Non-empty means nothing was written. */
  errors: string[]
  /** True when no write was attempted. */
  dryRun: boolean
}

interface ExistingRow {
  id: string
  pack_slug: string | null
  name: string
  description: string
  category: string
  entity_type: string
  lines: unknown
  is_active: boolean
}

/** Value-compare a pack against the row it maps to. */
function rowMatchesPack(row: ExistingRow, pack: LoadedPack['pack']): boolean {
  const desired = packToLibraryRow(pack)
  return (
    row.is_active === true &&
    row.name === desired.name &&
    row.description === desired.description &&
    row.category === desired.category &&
    row.entity_type === desired.entity_type &&
    // jsonb round-trips as parsed JSON; compare by value, not key order.
    JSON.stringify(normaliseLines(row.lines)) === JSON.stringify(normaliseLines(desired.lines))
  )
}

function normaliseLines(lines: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(lines)) return []
  return lines.map((l) =>
    Object.fromEntries(
      Object.entries(l as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
}

export async function syncSystemPacks(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; root?: string } = {},
): Promise<PackSyncResult> {
  const dryRun = opts.dryRun ?? false
  const result: PackSyncResult = {
    inserted: [], updated: [], unchanged: [], retired: [], errors: [], dryRun,
  }

  const { packs, errors } = loadPacks(opts.root)
  if (errors.length) {
    result.errors = errors.map((e) => `${e.file}: ${e.message}`)
    log.error('pack catalogue invalid, refusing to sync', { errorCount: errors.length })
    return result
  }
  if (packs.length === 0) {
    // An empty catalogue would otherwise retire every system template. That is
    // far more likely to be a broken deploy (packs/ not bundled) than intent.
    result.errors.push('no packs found: refusing to retire every system template')
    return result
  }

  const { data, error } = await supabase
    .from('booking_template_library')
    .select('id, pack_slug, name, description, category, entity_type, lines, is_active')
    .eq('is_system', true)

  if (error) throw error

  const existing = new Map<string, ExistingRow>()
  for (const row of (data ?? []) as ExistingRow[]) {
    if (row.pack_slug) existing.set(row.pack_slug, row)
  }

  for (const p of packs) {
    const slug = p.pack.meta.slug
    const row = existing.get(slug)
    const desired = packToLibraryRow(p.pack)

    if (!row) {
      result.inserted.push(slug)
      if (!dryRun) {
        // Columns spelled out rather than spread: the phantom-column guard
        // (tests/schema/no-phantom-columns.test.ts) cannot verify a runtime-built
        // payload, and a typo'd column here would fail only in production.
        const { error: insErr } = await supabase.from('booking_template_library').insert({
          name: desired.name,
          description: desired.description,
          category: desired.category,
          entity_type: desired.entity_type,
          is_system: true,
          lines: desired.lines,
          pack_slug: slug,
          is_active: true,
        })
        if (insErr) throw insErr
      }
      continue
    }

    if (rowMatchesPack(row, p.pack)) {
      result.unchanged.push(slug)
      continue
    }

    result.updated.push(slug)
    if (!dryRun) {
      const { error: updErr } = await supabase
        .from('booking_template_library')
        .update({
          name: desired.name,
          description: desired.description,
          category: desired.category,
          entity_type: desired.entity_type,
          lines: desired.lines,
          is_active: true,
        })
        .eq('id', row.id)
      if (updErr) throw updErr
    }
  }

  const packSlugs = new Set(packs.map((p) => p.pack.meta.slug))
  for (const [slug, row] of existing) {
    if (packSlugs.has(slug) || !row.is_active) continue
    result.retired.push(slug)
    if (!dryRun) {
      const { error: retErr } = await supabase
        .from('booking_template_library')
        .update({ is_active: false })
        .eq('id', row.id)
      if (retErr) throw retErr
    }
  }

  log.info('pack sync complete', {
    dryRun,
    inserted: result.inserted.length,
    updated: result.updated.length,
    unchanged: result.unchanged.length,
    retired: result.retired.length,
  })

  return result
}
