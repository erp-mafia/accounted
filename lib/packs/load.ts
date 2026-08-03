import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { PackSchema, type Pack } from './schema'

/**
 * Reading packs off disk.
 *
 * Node-only: uses `fs`, so this must never be imported from a client component
 * or from an edge path. The runtime consumers (the system-template loader, the
 * validator, the docs export) are all server-side or build-time.
 */

/** Repo-root-relative home of the pack catalogue. */
export const PACKS_DIR = 'packs'

export interface LoadedPack {
  /** Filename without extension. Must equal `pack.meta.slug`. */
  fileSlug: string
  /** Repo-relative path, for error messages. */
  file: string
  pack: Pack
}

export interface PackLoadError {
  file: string
  message: string
}

export interface PackLoadResult {
  packs: LoadedPack[]
  errors: PackLoadError[]
}

function packsDirAbs(root: string): string {
  return path.join(root, PACKS_DIR)
}

/** List pack files (`*.yaml`) in the catalogue, sorted by filename. */
export function listPackFiles(root: string = process.cwd()): string[] {
  const dir = packsDirAbs(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(dir, f))
}

/**
 * Load and schema-validate every pack.
 *
 * Collects errors rather than throwing on the first one: a validator that stops
 * at the first bad file makes fixing a batch a game of whack-a-mole. Structural
 * validation only. Cross-file rules (unique slug and order) and semantic rules
 * (accounts exist in BAS, the template balances) live in
 * `scripts/validate-packs.ts`, because they need the BAS chart and are a CI
 * gate rather than a runtime concern.
 */
export function loadPacks(root: string = process.cwd()): PackLoadResult {
  const packs: LoadedPack[] = []
  const errors: PackLoadError[] = []

  for (const abs of listPackFiles(root)) {
    const file = path.relative(root, abs).split(path.sep).join('/')
    const fileSlug = path.basename(abs, '.yaml')

    let raw: unknown
    try {
      raw = yaml.load(fs.readFileSync(abs, 'utf8'))
    } catch (err) {
      errors.push({ file, message: `YAML parse failed: ${(err as Error).message}` })
      continue
    }

    const parsed = PackSchema.safeParse(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length ? issue.path.join('.') : '(root)'
        errors.push({ file, message: `${where}: ${issue.message}` })
      }
      continue
    }

    packs.push({ fileSlug, file, pack: parsed.data })
  }

  return { packs, errors }
}

/**
 * Packs in display order.
 *
 * `meta.order` is the single source of truth: the in-app gallery and the docs
 * site both sort on it so they can never disagree. Ties fall back to slug only
 * so the sort is deterministic; the validator rejects duplicate orders, so a
 * tie means the catalogue is already invalid.
 */
export function sortPacks(packs: LoadedPack[]): LoadedPack[] {
  return [...packs].sort(
    (a, b) => a.pack.meta.order - b.pack.meta.order || a.pack.meta.slug.localeCompare(b.pack.meta.slug),
  )
}

/**
 * Shape a pack into the row the `booking_template_library` table stores.
 *
 * This is the bridge between the data files and the database: the system
 * templates are seeded from packs rather than from a frozen migration.
 */
export function packToLibraryRow(pack: Pack): {
  name: string
  description: string
  category: string
  entity_type: string
  is_system: true
  lines: Array<Record<string, unknown>>
} {
  return {
    name: pack.meta.name,
    description: pack.meta.description,
    category: pack.meta.category,
    entity_type: pack.meta.entity_type,
    is_system: true,
    // Key order matches the schema declaration, not the seeded JSONB: jsonb
    // does not preserve key order anyway, so equality is compared by value.
    lines: pack.lines.map((l) => {
      const row: Record<string, unknown> = {
        account: l.account,
        label: l.label,
        side: l.side,
        type: l.type,
      }
      if (l.ratio !== undefined) row.ratio = l.ratio
      if (l.vat_rate !== undefined) row.vat_rate = l.vat_rate
      return row
    }),
  }
}
