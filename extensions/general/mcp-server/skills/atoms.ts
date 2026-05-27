/**
 * Atom-registry → MCP skill adapter.
 *
 * The in-app composer (lib/agent/composer/) writes to `agent_atom_registry`;
 * each row points to a SKILL.md body on disk (under `.claude/skills/`). This
 * loader hydrates those rows into `Skill` objects so the existing
 * `gnubok_list_skills` / `gnubok_load_skill` tools can surface them to
 * Claude.ai users with no further work (plan §13 MCP parity).
 *
 * Atom slugs match their registry id verbatim: "horizontal/swedish-vat",
 * "vertical/konsult-it", "modifier/holding-ab". Workflow skills keep their
 * flat slugs ("month-end-close") and never collide with atom slugs.
 *
 * Cached per-process. Reset between tests via `__resetAtomCache`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Skill, SkillTier } from './types'

interface AtomRegistryRow {
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier'
  title: string | null
  description: string
  sni_prefixes: string[] | null
  body: string | null
  body_path: string
}

let cache: Skill[] | null = null

export async function loadAtomsAsSkills(supabase: SupabaseClient): Promise<Skill[]> {
  if (cache) return cache

  // `body` is read from the DB (seeded by scripts/generate-skill-bodies.ts) — not
  // from disk — so skills load identically on Vercel, Docker, and self-hosted.
  // `mcp_exposed` is the curation kill-switch: only atoms flagged for the MCP
  // surface reach Claude (swarm-* audit skills never become atoms in the first
  // place; this guards against any future row that shouldn't be end-user-loadable).
  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description, sni_prefixes, body, body_path')
    .eq('is_active', true)
    .eq('mcp_exposed', true)
    .is('parent_atom_id', null) // list top-level skills only; references resolve via loadReferenceById
    .order('id')

  if (error) {
    throw new Error(`Failed to load atom registry: ${error.message}`)
  }
  if (!data) {
    cache = []
    return cache
  }

  const rows = data as AtomRegistryRow[]
  const out: Skill[] = []

  for (const row of rows) {
    let body = row.body ?? ''
    if (!body) {
      // Dev convenience: before `npm run skills:generate` has populated the DB,
      // fall back to reading the SKILL.md from disk. In production the body is
      // always seeded by the generated migration, so this path is never taken.
      if (process.env.NODE_ENV !== 'production') {
        try {
          body = await readFile(join(process.cwd(), row.body_path), 'utf8')
        } catch {
          // fall through to the skip below
        }
      }
      if (!body) {
        console.warn(`[mcp-skills] atom ${row.id}: no body in DB and no on-disk fallback — skipping`)
        continue
      }
    }

    const sniRoot = row.sni_prefixes?.[0]?.split('.')[0]
    const tags = [row.tier, ...(sniRoot ? [`sni-${sniRoot}`] : [])]

    out.push({
      slug: row.id,
      name: row.title ?? row.id,
      summary: row.description,
      tags,
      body,
      tier: row.tier as SkillTier,
    })
  }

  cache = out
  return cache
}

/**
 * Resolve a single reference child (parent_atom_id IS NOT NULL) by exact id —
 * e.g. "horizontal/swedish-vat/vat-compliance-reference". References are
 * deliberately excluded from `loadAtomsAsSkills` (the listed catalog), so this
 * is the only path that surfaces them; gnubok_load_skill falls back here when a
 * slug isn't a workflow or a top-level atom. Returns null for unknown ids,
 * inactive rows, or rows the curation switch (mcp_exposed) has turned off.
 *
 * Not cached: references load rarely and on demand, so a per-id query is cheaper
 * than holding ~90 reference bodies in the process between calls.
 */
export async function loadReferenceById(
  supabase: SupabaseClient,
  id: string,
): Promise<Skill | null> {
  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description, sni_prefixes, body, body_path, is_active, mcp_exposed, parent_atom_id')
    .eq('id', id)
    .not('parent_atom_id', 'is', null)
    .maybeSingle()

  if (error) throw new Error(`Failed to load reference ${id}: ${error.message}`)
  if (!data || data.is_active === false || data.mcp_exposed === false) return null

  const row = data as AtomRegistryRow & { is_active: boolean; mcp_exposed: boolean }
  let body = row.body ?? ''
  if (!body) {
    // Same dev fallback as loadAtomsAsSkills: before the seed migration runs,
    // read the references/*.md straight off disk. Never taken in production.
    if (process.env.NODE_ENV !== 'production') {
      try {
        body = await readFile(join(process.cwd(), row.body_path), 'utf8')
      } catch {
        return null
      }
    }
    if (!body) return null
  }

  return {
    slug: row.id,
    name: row.title ?? row.id,
    summary: row.description,
    tags: [row.tier, 'reference'],
    body,
    tier: row.tier as SkillTier,
  }
}

/** Test-only: clear the module-level cache so the next call re-queries. */
export function __resetAtomCache(): void {
  cache = null
}
