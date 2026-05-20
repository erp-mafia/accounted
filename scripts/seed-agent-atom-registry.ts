#!/usr/bin/env npx tsx
/**
 * Seed / sync the agent_atom_registry table from SKILL.md files on disk.
 *
 * Scans `.claude/skills/` for atom skills and upserts a registry row per
 * skill. The registry is the catalog the composer queries when picking
 * an atom loadout for a company.
 *
 * Tiers discovered:
 *   horizontal  — `.claude/skills/swedish-*\/SKILL.md` (existing skills, regulatory)
 *   vertical    — `.claude/skills/industry/<slug>\/SKILL.md`   (Phase 3, optional)
 *   modifier    — `.claude/skills/modifier/<slug>\/SKILL.md`   (Phase 3, optional)
 *
 * Token estimates use a chars/4 heuristic. Per plan §10 + §18.11 we re-measure
 * on Opus 4.7's tokenizer (Swedish text can inflate up to ~35%) post-POC.
 *
 * Usage:
 *   npx tsx scripts/seed-agent-atom-registry.ts          # apply
 *   npx tsx scripts/seed-agent-atom-registry.ts --dry    # print plan only
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))
const SKILLS_DIR = join(ROOT, '.claude', 'skills')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)
const dryRun = process.argv.includes('--dry')

type Tier = 'horizontal' | 'vertical' | 'modifier'

interface AtomRow {
  id: string
  tier: Tier
  title: string
  description: string
  sni_prefixes: string[]
  trigger_signals: Record<string, unknown>
  estimated_tokens: number
  body_path: string
  version: number
  is_active: boolean
  schema_version: number
}

// ── Frontmatter parsing ────────────────────────────────────────────────
// Skill SKILL.md files use YAML frontmatter with `name`, `description`, and
// optionally `tier`, `sni_prefixes`, `trigger_signals`, `estimated_tokens`,
// `version`. We parse only the keys we care about — js-yaml is not in deps.

interface Frontmatter {
  raw: string
  name?: string
  title?: string
  description?: string
  tier?: Tier
  sniPrefixes?: string[]
  triggerSignals?: Record<string, unknown>
  estimatedTokens?: number
  version?: number
}

function extractFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const raw = match[1]
  return {
    raw,
    name: parseScalar(raw, 'name'),
    title: parseScalar(raw, 'title'),
    description: parseScalar(raw, 'description'),
    tier: parseScalar(raw, 'tier') as Tier | undefined,
    sniPrefixes: parseArray(raw, 'sni_prefixes'),
    triggerSignals: parseInlineObject(raw, 'trigger_signals'),
    estimatedTokens: parseNumber(raw, 'estimated_tokens'),
    version: parseNumber(raw, 'version'),
  }
}

// Handles `key: value`, `key: "quoted"`, `key: >`+folded, `key: |`+literal.
function parseScalar(yaml: string, key: string): string | undefined {
  // Inline form: `key: rest of line`
  const inline = new RegExp(`^${escapeKey(key)}:\\s*(.*)$`, 'm').exec(yaml)
  if (!inline) return undefined
  const head = inline[1].trim()

  // Folded (>) or literal (|) block scalar — gather indented continuation lines.
  if (head === '>' || head === '|' || head === '>-' || head === '|-') {
    const after = yaml.slice(inline.index + inline[0].length).split('\n')
    const lines: string[] = []
    for (const line of after) {
      if (line.length === 0) continue
      if (/^\s/.test(line)) {
        lines.push(line.trim())
      } else {
        break
      }
    }
    return head.startsWith('>') ? lines.join(' ') : lines.join('\n')
  }

  // Inline quoted or bare scalar.
  return unquote(head)
}

function parseNumber(yaml: string, key: string): number | undefined {
  const v = parseScalar(yaml, key)
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseArray(yaml: string, key: string): string[] | undefined {
  // Inline form: `key: ["a", "b"]`
  const inline = new RegExp(`^${escapeKey(key)}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(yaml)
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean)
  }
  return undefined
}

function parseInlineObject(yaml: string, key: string): Record<string, unknown> | undefined {
  // POC: only recognize `trigger_signals: {}` or absent. Deep parsing is
  // deferred — atoms can populate it later via direct DB edits or a richer
  // seeder once we author Phase 3 atoms.
  const line = new RegExp(`^${escapeKey(key)}:\\s*\\{\\s*\\}\\s*$`, 'm').exec(yaml)
  if (line) return {}
  return undefined
}

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

// ── Token estimation ──────────────────────────────────────────────────
// Chars/4 baseline (Anthropic guidance for English). Swedish text inflates
// on Opus 4.7's tokenizer (see plan §18.11) — re-measure post-POC.

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Title derivation ──────────────────────────────────────────────────

function deriveTitle(slug: string): string {
  // 'swedish-vat' → 'Swedish VAT'
  // 'swedish-year-end-closing' → 'Swedish Year-End Closing'
  return slug
    .split('-')
    .map((w) => (w === 'vat' || w === 'sru' || w === 'sie' ? w.toUpperCase() : capitalize(w)))
    .join(' ')
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

// ── Discovery ─────────────────────────────────────────────────────────

async function discoverAtoms(): Promise<AtomRow[]> {
  const rows: AtomRow[] = []
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    // Horizontal: top-level swedish-* directory
    if (entry.name.startsWith('swedish-')) {
      const row = await readAtom('horizontal', entry.name, join(SKILLS_DIR, entry.name))
      if (row) rows.push(row)
      continue
    }

    // Vertical / modifier: subdirectories under those names
    if (entry.name === 'industry' || entry.name === 'modifier') {
      const tier: Tier = entry.name === 'industry' ? 'vertical' : 'modifier'
      const tierDir = join(SKILLS_DIR, entry.name)
      const subs = await readdir(tierDir, { withFileTypes: true })
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        const row = await readAtom(tier, sub.name, join(tierDir, sub.name))
        if (row) rows.push(row)
      }
    }
  }

  return rows
}

async function readAtom(tier: Tier, slug: string, dir: string): Promise<AtomRow | null> {
  const skillPath = join(dir, 'SKILL.md')
  try {
    await stat(skillPath)
  } catch {
    return null
  }

  const content = await readFile(skillPath, 'utf8')
  const fm = extractFrontmatter(content)
  if (!fm) {
    console.warn(`  skipped ${relative(ROOT, skillPath)} — no frontmatter`)
    return null
  }
  if (!fm.description) {
    console.warn(`  skipped ${relative(ROOT, skillPath)} — missing description`)
    return null
  }

  // Token estimate spans SKILL.md + every reference .md alongside it.
  // The loader assembles the system prompt from the full atom body, so the
  // budget must reflect the full body, not just SKILL.md.
  const allMarkdown = await collectMarkdown(dir)

  const id = `${tier}/${slug}`
  return {
    id,
    tier: fm.tier ?? tier,
    // Prefer the human-authored title from frontmatter; fall back to
    // deriveTitle for skills (the swedish-* horizontals) that don't declare
    // one. deriveTitle's output is intentionally minimal — it just
    // reformats the slug.
    title: fm.title ?? deriveTitle(slug),
    description: fm.description,
    sni_prefixes: fm.sniPrefixes ?? [],
    trigger_signals: fm.triggerSignals ?? {},
    estimated_tokens: fm.estimatedTokens ?? estimateTokens(allMarkdown),
    body_path: relative(ROOT, skillPath),
    version: fm.version ?? 1,
    is_active: true,
    schema_version: 1,
  }
}

async function collectMarkdown(dir: string): Promise<string> {
  const parts: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    const entries = await readdir(cur, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        parts.push(await readFile(full, 'utf8'))
      }
    }
  }
  return parts.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`Scanning ${relative(process.cwd(), SKILLS_DIR)}`)
  const rows = await discoverAtoms()

  if (rows.length === 0) {
    console.log('No atoms discovered.')
    return
  }

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
