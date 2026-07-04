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
 * Tiers discovered (the curated set: swarm-* and other Claude-Code-only skills
 * are intentionally NOT matched here, so they never become atoms):
 *   horizontal: `.claude/skills/swedish-*\/SKILL.md`        (regulatory)
 *   vertical  : `.claude/skills/industry/<slug>\/SKILL.md`  (industry)
 *   modifier  : `.claude/skills/modifier/<slug>\/SKILL.md`  (cross-cutting)
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

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
   * Token estimate over the SKILL.md content ONLY: the unit actually loaded
   * into the system prompt / returned by gnubok_load_skill. (We deliberately do
   * NOT count references/*.md, which are not read at runtime.)
   */
  estimated_tokens: number
  /**
   * Repo-relative path to the body source: SKILL.md for top-level skills,
   * the references/*.md file for reference children (provenance + dev-fallback).
   */
  body_path: string
  /**
   * Body inlined into the DB. For a top-level skill: the raw SKILL.md content
   * (frontmatter included) with a "Loadable references" footer appended when the
   * skill has any. For a reference child: the raw references/*.md content.
   */
  body: string
  /**
   * NULL for a top-level skill; the parent skill's id for a reference child.
   * Reference rows are hidden from every catalog (the metadata index, the MCP
   * skill list, the composer atom index, the settings panel) by a
   * `parent_atom_id IS NULL` filter: they reach the model only via an explicit
   * gnubok_load_skill(<child id>) call after the parent SKILL.md is loaded.
   */
  parent_atom_id: string | null
  /** Version declared in frontmatter, or 1. The generator may override this. */
  frontmatter_version: number
  schema_version: number
}

// Normalize CRLF → LF so frontmatter parsing and body inlining are
// platform-independent (Windows checkouts ship .md files with CRLF unless
// .gitattributes forces LF, which it doesn't for *.md).
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// ── Frontmatter parsing ────────────────────────────────────────────────
// SKILL.md files use YAML frontmatter with `name`, `description`, and optionally
// `tier`, `sni_prefixes`, `trigger_signals`, `estimated_tokens`, `version`. We
// parse only the keys we care about: js-yaml is not in deps.

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
// Opus 4.7's tokenizer: re-measure post-POC.
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
      rows.push(...(await readAtom(rootDir, 'horizontal', entry.name, join(skillsDir, entry.name))))
      continue
    }

    // Vertical / modifier: subdirectories under those names
    if (entry.name === 'industry' || entry.name === 'modifier') {
      const tier: Tier = entry.name === 'industry' ? 'vertical' : 'modifier'
      const tierDir = join(skillsDir, entry.name)
      const subs = await readdir(tierDir, { withFileTypes: true })
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        rows.push(...(await readAtom(rootDir, tier, sub.name, join(tierDir, sub.name))))
      }
    }
  }

  rows.sort((a, b) => a.id.localeCompare(b.id))
  return rows
}

/**
 * Read one skill directory into a top-level atom plus one child atom per
 * references/*.md file. Returns an empty array if the SKILL.md is missing or
 * lacks the frontmatter we require.
 */
async function readAtom(
  rootDir: string,
  tier: Tier,
  slug: string,
  dir: string
): Promise<DiscoveredAtom[]> {
  const skillPath = join(dir, 'SKILL.md')
  try {
    await stat(skillPath)
  } catch {
    return []
  }

  const content = normalizeLineEndings(await readFile(skillPath, 'utf8'))
  const fm = extractFrontmatter(content)
  if (!fm) {
    console.warn(`  skipped ${relative(rootDir, skillPath)}: no frontmatter`)
    return []
  }
  if (!fm.description) {
    console.warn(`  skipped ${relative(rootDir, skillPath)}: missing description`)
    return []
  }

  const parentId = `${tier}/${slug}`
  const childTier: Tier = fm.tier ?? tier
  const refs = await readReferenceFiles(dir)

  // Bridge the SKILL.md router (which points at dead `references/*.md` paths at
  // runtime) to the loadable child ids the model can actually call. Appended to
  // the parent body so it ships in the seeded DB body, visible only once the
  // skill itself is loaded.
  const body = refs.length > 0 ? content + buildReferencesFooter(parentId, refs) : content

  const parent: DiscoveredAtom = {
    id: parentId,
    tier: childTier,
    slug,
    title: fm.title ?? deriveTitle(slug),
    description: fm.description,
    sni_prefixes: fm.sniPrefixes ?? [],
    trigger_signals: fm.triggerSignals ?? {},
    // Estimate over the loaded unit (SKILL.md + footer), not the whole
    // directory: references are loaded separately and budgeted on their own row.
    estimated_tokens: fm.estimatedTokens ?? estimateTokens(body),
    body_path: relative(rootDir, skillPath),
    body,
    parent_atom_id: null,
    frontmatter_version: fm.version ?? 1,
    schema_version: 1,
  }

  const children: DiscoveredAtom[] = refs.map((r) => ({
    id: `${parentId}/${r.slug}`,
    tier: childTier,
    slug: `${slug}/${r.slug}`,
    title: r.descriptor || deriveTitle(r.slug),
    description: r.descriptor
      ? `${r.descriptor}: reference for ${parent.title}`
      : `Reference for ${parent.title}`,
    sni_prefixes: [],
    trigger_signals: {},
    estimated_tokens: estimateTokens(r.body),
    body_path: relative(rootDir, r.absPath),
    body: r.body,
    parent_atom_id: parentId,
    frontmatter_version: 1,
    schema_version: 1,
  }))

  return [parent, ...children]
}

// ── Reference discovery ───────────────────────────────────────────────
// A skill's deep material lives in <skillDir>/references/**.md. Each file
// becomes a hidden child atom loadable by id; the bytes never count toward the
// parent's token budget and never appear in any catalog listing.

interface ReferenceFile {
  /** Absolute path on disk (provenance + dev-fallback anchor). */
  absPath: string
  /** Path as the SKILL.md router writes it, e.g. "references/bfl-bfnar.md". */
  relPath: string
  /** Child-id suffix derived from the path, e.g. "bfl-bfnar". */
  slug: string
  /** Raw file content: the child's DB-inlined body. */
  body: string
  /** First ATX heading (or first line), used as a human-readable label. */
  descriptor: string
}

async function readReferenceFiles(skillDir: string): Promise<ReferenceFile[]> {
  const refsDir = join(skillDir, 'references')
  try {
    await stat(refsDir)
  } catch {
    return []
  }

  const files = (await walkMarkdown(refsDir)).sort()
  const out: ReferenceFile[] = []
  for (const absPath of files) {
    const body = normalizeLineEndings(await readFile(absPath, 'utf8'))
    const relFromRefs = relative(refsDir, absPath).split(sep).join('/')
    out.push({
      absPath,
      relPath: `references/${relFromRefs}`,
      slug: relFromRefs.replace(/\.md$/i, '').replace(/\//g, '-'),
      body,
      descriptor: firstHeadingOrLine(body),
    })
  }
  return out
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkMarkdown(p)))
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p)
  }
  return out
}

function firstHeadingOrLine(md: string): string {
  const lines = md.split('\n')
  for (const line of lines) {
    const h = /^#{1,3}\s+(.+?)\s*#*$/.exec(line.trim())
    if (h) return h[1].trim()
  }
  for (const line of lines) {
    const t = line.trim()
    if (t.length > 0) return t.slice(0, 100)
  }
  return ''
}

function buildReferencesFooter(parentId: string, refs: ReferenceFile[]): string {
  const lines = [
    '',
    '---',
    '',
    '## Loadable references',
    '',
    'The reference files named above are NOT included in this body. When a question genuinely needs that depth, load the specific one on demand with `gnubok_load_skill`, and only then:',
    '',
  ]
  for (const r of refs) {
    const label = r.descriptor ? `: ${r.descriptor}` : ''
    lines.push(`- \`${r.relPath}\` → \`gnubok_load_skill("${parentId}/${r.slug}")\`${label}`)
  }
  return '\n' + lines.join('\n') + '\n'
}
