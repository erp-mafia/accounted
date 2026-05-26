/**
 * Shared atom discovery + SKILL.md frontmatter parsing.
 *
 * Used by both:
 *   - scripts/seed-agent-atom-registry.ts  (dev/manual: writes the registry directly)
 *   - scripts/generate-skill-bodies.ts     (production: emits a seed migration)
 *
 * Keeping discovery in one place means the two paths can never drift on which
 * skills count as atoms, how titles/tokens are derived, or how frontmatter is read.
 *
 * Tiers discovered (the curated set — swarm-* and other Claude-Code-only skills
 * are intentionally NOT matched here, so they never become atoms):
 *   horizontal — `.claude/skills/swedish-*\/SKILL.md`        (regulatory)
 *   vertical   — `.claude/skills/industry/<slug>\/SKILL.md`  (industry)
 *   modifier   — `.claude/skills/modifier/<slug>\/SKILL.md`  (cross-cutting)
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export type Tier = 'horizontal' | 'vertical' | 'modifier'

export interface DiscoveredAtom {
  /** Stable id shaped as "<tier>/<slug>" (e.g. "horizontal/swedish-vat"). */
  id: string
  tier: Tier
  slug: string
  title: string
  description: string
  sni_prefixes: string[]
  trigger_signals: Record<string, unknown>
  /**
   * Token estimate over the SKILL.md content ONLY — the unit actually loaded
   * into the system prompt / returned by gnubok_load_skill. (We deliberately do
   * NOT count references/*.md, which are not read at runtime.)
   */
  estimated_tokens: number
  /** Repo-relative path to SKILL.md (provenance + dev-fallback anchor). */
  body_path: string
  /** Raw SKILL.md content, frontmatter included — the DB-inlined body. */
  body: string
  /** Version declared in frontmatter, or 1. The generator may override this. */
  frontmatter_version: number
  schema_version: number
}

// ── Frontmatter parsing ────────────────────────────────────────────────
// SKILL.md files use YAML frontmatter with `name`, `description`, and optionally
// `tier`, `sni_prefixes`, `trigger_signals`, `estimated_tokens`, `version`. We
// parse only the keys we care about — js-yaml is not in deps.

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
  const inline = new RegExp(`^${escapeKey(key)}:\\s*(.*)$`, 'm').exec(yaml)
  if (!inline) return undefined
  const head = inline[1].trim()

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

  return unquote(head)
}

function parseNumber(yaml: string, key: string): number | undefined {
  const v = parseScalar(yaml, key)
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseArray(yaml: string, key: string): string[] | undefined {
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
  // POC: only recognize `trigger_signals: {}` or absent. Deep parsing is deferred.
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
// Chars/4 baseline (Anthropic guidance for English). Swedish text inflates on
// Opus 4.7's tokenizer — re-measure post-POC.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Title derivation ──────────────────────────────────────────────────
export function deriveTitle(slug: string): string {
  // 'swedish-vat' → 'Swedish VAT'; 'swedish-year-end-closing' → 'Swedish Year-End Closing'
  return slug
    .split('-')
    .map((w) => (w === 'vat' || w === 'sru' || w === 'sie' ? w.toUpperCase() : capitalize(w)))
    .join(' ')
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

// ── Discovery ─────────────────────────────────────────────────────────

/**
 * Scan `<rootDir>/.claude/skills/` and return one DiscoveredAtom per skill,
 * sorted by id for deterministic output. Skills without frontmatter or without
 * a description are skipped (with a warning).
 */
export async function discoverAtoms(rootDir: string): Promise<DiscoveredAtom[]> {
  const skillsDir = join(rootDir, '.claude', 'skills')
  const rows: DiscoveredAtom[] = []
  const entries = await readdir(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    // Horizontal: top-level swedish-* directory
    if (entry.name.startsWith('swedish-')) {
      const row = await readAtom(rootDir, 'horizontal', entry.name, join(skillsDir, entry.name))
      if (row) rows.push(row)
      continue
    }

    // Vertical / modifier: subdirectories under those names
    if (entry.name === 'industry' || entry.name === 'modifier') {
      const tier: Tier = entry.name === 'industry' ? 'vertical' : 'modifier'
      const tierDir = join(skillsDir, entry.name)
      const subs = await readdir(tierDir, { withFileTypes: true })
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        const row = await readAtom(rootDir, tier, sub.name, join(tierDir, sub.name))
        if (row) rows.push(row)
      }
    }
  }

  rows.sort((a, b) => a.id.localeCompare(b.id))
  return rows
}

async function readAtom(
  rootDir: string,
  tier: Tier,
  slug: string,
  dir: string
): Promise<DiscoveredAtom | null> {
  const skillPath = join(dir, 'SKILL.md')
  try {
    await stat(skillPath)
  } catch {
    return null
  }

  const content = await readFile(skillPath, 'utf8')
  const fm = extractFrontmatter(content)
  if (!fm) {
    console.warn(`  skipped ${relative(rootDir, skillPath)} — no frontmatter`)
    return null
  }
  if (!fm.description) {
    console.warn(`  skipped ${relative(rootDir, skillPath)} — missing description`)
    return null
  }

  return {
    id: `${tier}/${slug}`,
    tier: fm.tier ?? tier,
    slug,
    title: fm.title ?? deriveTitle(slug),
    description: fm.description,
    sni_prefixes: fm.sniPrefixes ?? [],
    trigger_signals: fm.triggerSignals ?? {},
    // Granularity fix: estimate over SKILL.md content only (the loaded unit),
    // not the whole directory — so the budget matches the real system-prompt cost.
    estimated_tokens: fm.estimatedTokens ?? estimateTokens(content),
    body_path: relative(rootDir, skillPath),
    body: content,
    frontmatter_version: fm.version ?? 1,
    schema_version: 1,
  }
}
