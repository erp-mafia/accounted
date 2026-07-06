#!/usr/bin/env npx tsx
/**
 * Seed / sync the agent_atom_registry table from SKILL.md files on disk.
 *
 * DEV / MANUAL path only. It writes the registry directly with the service role,
 * which needs DB access: so it is NOT part of prebuild. Production gets skill
 * bodies via the generated seed migration (scripts/generate-skill-bodies.ts),
 * which ships in supabase/migrations and runs on deploy.
 *
 * Discovery + frontmatter parsing live in scripts/lib/atom-discovery.ts so this
 * and the generator can never drift on which skills count as atoms.
 *
 * Usage:
 *   npx tsx scripts/seed-agent-atom-registry.ts          # apply
 *   npx tsx scripts/seed-agent-atom-registry.ts --dry    # print plan only
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import { dirname, relative, join } from 'node:path'
import { discoverAtoms } from './lib/atom-discovery'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)
const dryRun = process.argv.includes('--dry')

async function main() {
  console.log(`Scanning ${relative(process.cwd(), join(ROOT, '.claude', 'skills'))}`)
  const atoms = await discoverAtoms(ROOT)

  if (atoms.length === 0) {
    console.log('No atoms discovered.')
    return
  }

  // Map discovery → registry rows. We intentionally OMIT mcp_exposed so that a
  // manual kill-switch flip survives a re-seed (the column default applies on
  // first insert; ON CONFLICT leaves it untouched). `body` is inlined so runtime
  // reads from the DB rather than disk.
  const rows = atoms.map((a) => ({
    id: a.id,
    tier: a.tier,
    title: a.title,
    description: a.description,
    sni_prefixes: a.sni_prefixes,
    trigger_signals: a.trigger_signals,
    estimated_tokens: a.estimated_tokens,
    body_path: a.body_path,
    body: a.body,
    parent_atom_id: a.parent_atom_id,
    version: a.frontmatter_version,
    is_active: true,
    schema_version: a.schema_version,
  }))

  console.log(`\nFound ${rows.length} atoms:\n`)
  for (const r of rows) {
    console.log(`  [${r.tier.padEnd(10)}] ${r.id.padEnd(40)} ${r.estimated_tokens.toString().padStart(6)} tokens`)
  }

  if (dryRun) {
    console.log('\n--dry: skipping write.')
    return
  }

  console.log('\nUpserting...')
  const { error } = await supabase.from('agent_atom_registry').upsert(rows, { onConflict: 'id' })
  if (error) {
    console.error('Upsert failed:', error)
    process.exit(1)
  }

  console.log(`Upserted ${rows.length} rows into agent_atom_registry.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
