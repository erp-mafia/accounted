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
  body_path: string
}

let cache: Skill[] | null = null

export async function loadAtomsAsSkills(supabase: SupabaseClient): Promise<Skill[]> {
  if (cache) return cache

  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description, sni_prefixes, body_path')
    .eq('is_active', true)
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
    let body: string
    try {
      body = await readFile(join(process.cwd(), row.body_path), 'utf8')
    } catch (err) {
      // Atom registered but body file missing — skip rather than crash the
      // whole list response. Composer queries the same registry but reads
      // body_path identically, so a missing file is a deployment/sync issue
      // worth surfacing in logs but not worth taking the tool down for.
      console.warn(`[mcp-skills] atom ${row.id}: failed to read ${row.body_path}: ${(err as Error).message}`)
      continue
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

/** Test-only: clear the module-level cache so the next call re-queries. */
export function __resetAtomCache(): void {
  cache = null
}
