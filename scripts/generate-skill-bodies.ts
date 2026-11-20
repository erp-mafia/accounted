#!/usr/bin/env npx tsx
/**
 * Generate a Supabase seed migration that inlines atom SKILL.md bodies into
 * agent_atom_registry.body.
 *
 * Why a generated migration (not a runtime/seed-script write):
 *   - Vercel's build has no DB, so prebuild seeding can't write.
 *   - Skill bodies must reach prod via the one deploy path the project trusts:
 *     supabase/migrations applied on deploy. The SQL is generated, never hand-authored.
 *   - It also fixes the "registry never seeded" case (the manual seed may never have
 *     run in production): the migration populates the rows on deploy.
 *
 * Determinism:
 *   - Atoms are emitted sorted by id; bodies are dollar-quoted with a collision-proof
 *     tag; `version` is derived from a committed content-hash manifest
 *     (scripts/.skill-body-manifest.json) so it only bumps when an atom's row changes.
 *   - A no-change run emits NOTHING (byte-identical repo). A change emits ONE new
 *     timestamped migration (append-only: we never edit an existing migration).
 *
 * Incremental:
 *   - The manifest records the row every earlier seed migration shipped (hash of the
 *     seeded columns + version). A new seed carries only the atoms added or changed
 *     against it, plus withdrawals, so replaying every seed in order on an empty
 *     database builds the same registry one full seed of today's files would.
 *
 * Usage:
 *   npx tsx scripts/generate-skill-bodies.ts          # emit a migration if skills changed
 *   npx tsx scripts/generate-skill-bodies.ts --check  # CI guard: exit 1 if a skill changed
 *                                                      # without a regenerated migration
 */

import { createHash } from 'node:crypto'
import { readdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAtoms, type DiscoveredAtom } from './lib/atom-discovery'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const MANIFEST_PATH = join(ROOT, 'scripts', '.skill-body-manifest.json')

const checkOnly = process.argv.includes('--check')

export interface ManifestEntry {
  hash: string
  version: number
}
export type Manifest = Record<string, ManifestEntry>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) return {}
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  } catch {
    return {}
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  // Sorted keys for stable diffs.
  const sorted: Manifest = {}
  for (const id of Object.keys(manifest).sort()) sorted[id] = manifest[id]
  await writeFile(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

/** Wrap a string in a dollar-quote tag guaranteed not to appear inside it. */
function dollarQuote(s: string): string {
  let tag = '$gb$'
  let n = 0
  while (s.includes(tag)) {
    tag = `$gb${n}$`
    n++
  }
  return `${tag}${s}${tag}`
}

/** Single-quoted SQL text literal (apostrophes doubled). For short, simple values. */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function sqlTextArray(arr: string[]): string {
  if (arr.length === 0) return `'{}'::text[]`
  return `ARRAY[${arr.map(sqlStr).join(', ')}]::text[]`
}

/** Next migration timestamp = max existing 14-digit prefix + 1 (guarantees ordering). */
async function nextMigrationTimestamp(): Promise<string> {
  const files = await readdir(MIGRATIONS_DIR)
  // 14-digit timestamps (max ~1e14) are well within Number.MAX_SAFE_INTEGER (~9e15).
  let max = 0
  for (const f of files) {
    const m = /^(\d{14})_/.exec(f)
    if (m) {
      const n = Number(m[1])
      if (n > max) max = n
    }
  }
  return String(max + 1).padStart(14, '0')
}

/** Every column the seed writes for an atom except `version`, in one place. */
function seedColumns(atom: DiscoveredAtom) {
  return {
    id: atom.id,
    tier: atom.tier,
    title: atom.title,
    description: atom.description,
    sni_prefixes: atom.sni_prefixes,
    trigger_signals: JSON.stringify(atom.trigger_signals ?? {}),
    estimated_tokens: atom.estimated_tokens,
    body_path: atom.body_path,
    body: atom.body,
    parent_atom_id: atom.parent_atom_id,
    schema_version: atom.schema_version,
    mcp_exposed: atom.mcp_exposed ?? true,
    reviewed_at: atom.reviewed_at || null,
  }
}

/**
 * Fingerprint of the row the seed writes for an atom, version aside. A seed
 * re-emits an atom exactly when this changes, so a title, path or token-count
 * edit ships the same way a body edit does.
 */
export function atomHash(atom: DiscoveredAtom): string {
  return sha256(JSON.stringify(seedColumns(atom)))
}

function buildValuesRow(atom: DiscoveredAtom, version: number): string {
  const c = seedColumns(atom)
  return [
    '  (',
    `    ${sqlStr(c.id)},`,
    `    ${sqlStr(c.tier)},`,
    `    ${sqlStr(c.title)},`,
    `    ${dollarQuote(c.description)},`,
    `    ${sqlTextArray(c.sni_prefixes)},`,
    `    ${dollarQuote(c.trigger_signals)}::jsonb,`,
    `    ${c.estimated_tokens},`,
    `    ${sqlStr(c.body_path)},`,
    `    ${dollarQuote(c.body)},`,
    `    ${c.parent_atom_id ? sqlStr(c.parent_atom_id) : 'NULL'},`,
    `    ${version},`,
    `    ${c.schema_version},`,
    `    ${c.mcp_exposed},`,
    `    ${c.reviewed_at ? sqlStr(c.reviewed_at) : 'NULL'}`,
    '  )',
  ].join('\n')
}

export interface SeedPlan {
  added: string[]
  changed: string[]
  /** Ids an earlier seed shipped that are no longer agent atoms. */
  removed: string[]
  /** Removed ids whose rows the seed switches off (see buildMigrationSql). */
  withdrawn: string[]
  /** Added and changed atoms: the only rows the next seed writes. */
  upserts: DiscoveredAtom[]
  versions: Record<string, number>
  /** The manifest to commit with the seed. */
  manifest: Manifest
}

/**
 * Diff today's atoms against the manifest of what earlier seeds shipped. New atoms
 * start at version 1; an atom whose row changed is bumped by one; an unchanged atom
 * keeps its version and stays out of the seed, because an earlier seed already wrote
 * exactly that row.
 */
export function planSeed(atoms: DiscoveredAtom[], developerOnly: string[], previous: Manifest): SeedPlan {
  const added: string[] = []
  const changed: string[] = []
  const upserts: DiscoveredAtom[] = []
  const versions: Record<string, number> = {}
  const manifest: Manifest = {}
  for (const atom of atoms) {
    const hash = atomHash(atom)
    const prev = previous[atom.id]
    let version = 1
    if (!prev) {
      added.push(atom.id)
      upserts.push(atom)
    } else if (prev.hash !== hash) {
      changed.push(atom.id)
      upserts.push(atom)
      version = prev.version + 1
    } else {
      version = prev.version
    }
    versions[atom.id] = version
    manifest[atom.id] = { hash, version }
  }
  const current = new Set(atoms.map((a) => a.id))
  const developer = new Set(developerOnly)
  const removed = Object.keys(previous).filter((id) => !current.has(id)).sort()
  // Switched off once, by the seed that sees the id go: a community skill that
  // left the repo, or a reference now marked developer-only (the ones an earlier
  // seed shipped were switched off by that seed). Any other removed row stays as
  // it is, as it always has.
  const withdrawn = removed.filter((id) => id.startsWith('community/') || developer.has(id))
  return { added, changed, removed, withdrawn, upserts, versions, manifest }
}

export function buildMigrationSql(atoms: DiscoveredAtom[], versions: Record<string, number>, withdrawn: string[] = []): string {
  const header = `-- AUTO-GENERATED by scripts/generate-skill-bodies.ts: DO NOT EDIT BY HAND.
-- Regenerate with \`npm run skills:generate\` after editing any .claude/skills/**/SKILL.md.
--
-- Seeds agent_atom_registry rows with their SKILL.md body so the MCP server and the
-- in-app agent read skill content from the DB (works on Vercel, Docker, self-hosted).
-- Incremental: carries only the atoms added or changed since the previous seed, plus
-- withdrawals; replaying every seed in order builds the whole registry.
-- Idempotent: ON CONFLICT refreshes content fields but leaves is_active and
-- mcp_exposed under manual control (they take column defaults on first insert).
-- The WHERE guard skips rows whose registry version is newer than this seed's, so
-- a seed that applies after a newer one can never downgrade an atom.
`

  const values = atoms.map((a) => buildValuesRow(a, versions[a.id])).join(',\n')

  const insert = !atoms.length ? '' : `INSERT INTO public.agent_atom_registry
  (id, tier, title, description, sni_prefixes, trigger_signals, estimated_tokens, body_path, body, parent_atom_id, version, schema_version, mcp_exposed, reviewed_at)
VALUES
${values}
ON CONFLICT (id) DO UPDATE SET
  tier = EXCLUDED.tier,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  sni_prefixes = EXCLUDED.sni_prefixes,
  trigger_signals = EXCLUDED.trigger_signals,
  estimated_tokens = EXCLUDED.estimated_tokens,
  body_path = EXCLUDED.body_path,
  body = EXCLUDED.body,
  parent_atom_id = EXCLUDED.parent_atom_id,
  version = EXCLUDED.version,
  schema_version = EXCLUDED.schema_version,
  mcp_exposed = CASE WHEN EXCLUDED.tier = 'community' THEN EXCLUDED.mcp_exposed ELSE public.agent_atom_registry.mcp_exposed END,
  reviewed_at = COALESCE(EXCLUDED.reviewed_at, public.agent_atom_registry.reviewed_at),
  updated_at = now()
WHERE public.agent_atom_registry.version <= EXCLUDED.version;
`

  // Withdrawn rows (a community skill that left the repo, a reference now marked
  // developer-only) are switched off by id, kept and never deleted: other tables
  // reference them. Moving a file back to `agent` re-seeds its body but leaves
  // is_active to a person.
  const withdraw = withdrawn.length ? `UPDATE public.agent_atom_registry SET is_active = false, mcp_exposed = false WHERE id IN (${withdrawn.map(sqlStr).join(', ')});\n` : ''
  return `${header}\n${insert}\n${withdraw}\nNOTIFY pgrst, 'reload schema';\n`
}

async function main() {
  const discovered = await discoverAtoms(ROOT)
  const atoms = discovered.filter((a) => a.audience === 'agent')
  const developerOnly = discovered.filter((a) => a.audience === 'developer').map((a) => a.id)
  if (atoms.length === 0) {
    console.error('No atoms discovered under .claude/skills/: refusing to emit an empty seed.')
    process.exit(1)
  }

  // Dangling references/ links (mcp_optimization_plan P2-2): an atom body
  // pointing at a references/ file that does not exist ships a 404 to every
  // agent that follows it. Fails BOTH modes so a dangling pointer can never
  // reach the registry. Top-level atoms only: reference children live inside
  // references/ themselves, so relative links would double-resolve.
  const refLinkRe = /(?:\]\(|\b)\.?\/?(references\/[A-Za-z0-9._/-]+\.md)/g
  const danglingRefs: string[] = []
  for (const atom of atoms) {
    if (atom.parent_atom_id) continue
    const baseDir = dirname(join(ROOT, atom.body_path))
    const seen = new Set<string>()
    for (const m of atom.body.matchAll(refLinkRe)) {
      const rel = m[1]
      if (seen.has(rel)) continue
      seen.add(rel)
      if (!existsSync(join(baseDir, rel))) danglingRefs.push(`${atom.id}: ${rel}`)
    }
  }
  if (danglingRefs.length > 0) {
    console.error('✗ dangling references/ link(s) in atom bodies: create the file or remove the pointer:')
    for (const d of danglingRefs) console.error(`  ${d}`)
    process.exit(1)
  }

  const plan = planSeed(atoms, developerOnly, loadManifest())
  const { added, changed, removed, withdrawn } = plan
  const hasDrift = added.length > 0 || changed.length > 0 || removed.length > 0

  if (checkOnly) {
    if (!hasDrift) {
      console.log(`✓ skill bodies up to date (${atoms.length} atoms).`)
      return
    }
    console.error('✗ skill bodies are STALE: a SKILL.md changed without regenerating the seed migration.')
    if (added.length) console.error(`  added:   ${added.join(', ')}`)
    if (changed.length) console.error(`  changed: ${changed.join(', ')}`)
    if (removed.length) console.error(`  removed: ${removed.join(', ')}`)
    console.error('\nRun `npm run skills:generate` and commit the emitted migration.')
    process.exit(1)
  }

  if (!hasDrift) {
    console.log(`✓ no skill changes (${atoms.length} atoms): nothing to generate.`)
    return
  }

  // A removed file that needs no withdrawal changes no row: record it in the
  // manifest without an empty migration.
  if (plan.upserts.length || withdrawn.length) {
    const ts = await nextMigrationTimestamp()
    const fileName = `${ts}_seed_agent_atom_bodies.sql`
    await writeFile(join(MIGRATIONS_DIR, fileName), buildMigrationSql(plan.upserts, plan.versions, withdrawn), 'utf8')
    console.log(`Wrote supabase/migrations/${fileName} (${plan.upserts.length} of ${atoms.length} atoms).`)
  } else {
    console.log('No registry row changes: manifest updated, no migration needed.')
  }
  await saveManifest(plan.manifest)

  if (added.length) console.log(`  added:   ${added.join(', ')}`)
  if (changed.length) console.log(`  changed: ${changed.join(', ')}`)
  if (withdrawn.length) console.log(`  withdrawn (rows switched off): ${withdrawn.join(', ')}`)
  const dropped = removed.filter((id) => !withdrawn.includes(id))
  if (dropped.length) console.log(`  removed (rows left as they are): ${dropped.join(', ')}`)
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
