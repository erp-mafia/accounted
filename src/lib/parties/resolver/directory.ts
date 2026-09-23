/**
 * Counterpart resolver, the directory: the shared knowledge of what a bank
 * string means, consulted before any model call.
 *
 * Two layers. The seed (directory-seed.ts) ships with the code and is matched
 * on whole tokens of the pre-cleaned text, longest pattern first. The table
 * counterparty_directory holds readings promoted from two or more companies,
 * keyed by the alias key, a giro number or a domain. Both are brand level:
 * the table never holds a person, and never holds a reading only one
 * company produced.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DIRECTORY_SEED, type DirectoryEntry, type DirectoryKind } from './directory-seed'
import type { Precleaned } from './preclean'

export interface DirectoryMatch {
  key: string
  name: string
  kind: DirectoryKind
  country: string | null
  what: string | null
  rail: string | null
  logoDomain: string | null
  confidence: number
  source: 'seed' | 'promoted'
}

export const SEED_CONFIDENCE = 0.95
export const PROMOTED_CONFIDENCE = 0.9
export const GIRO_CONFIDENCE = 0.98
export const PROMOTION_MIN_COMPANIES = 2
export const PROMOTABLE_KINDS: ReadonlySet<string> = new Set(['merchant', 'authority', 'bank', 'rail'])

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

interface CompiledPattern {
  re: RegExp
  /** The pattern with punctuation folded to spaces, tested against the text folded the same way. */
  spaced: RegExp
  entry: DirectoryEntry
}

function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9åäöé]+/g, ' ').trim()
}

let compiled: CompiledPattern[] | null = null
let giroIndex: Map<string, DirectoryEntry> | null = null

function compile(): CompiledPattern[] {
  if (compiled) return compiled
  const all: Array<{ pattern: string; entry: DirectoryEntry }> = []
  for (const entry of DIRECTORY_SEED) for (const pattern of entry.patterns) all.push({ pattern: pattern.toLowerCase(), entry })
  all.sort((a, b) => b.pattern.length - a.pattern.length)
  compiled = all.map(({ pattern, entry }) => ({
    re: new RegExp(`(?:^|[^a-z0-9åäöé])${escapeRe(pattern)}(?=$|[^a-z0-9åäöé])`, 'i'),
    spaced: new RegExp(`(?:^|\\s)${escapeRe(fold(pattern))}(?=$|\\s)`),
    entry,
  }))
  return compiled
}

function giros(): Map<string, DirectoryEntry> {
  if (giroIndex) return giroIndex
  giroIndex = new Map()
  for (const entry of DIRECTORY_SEED) for (const g of entry.giro ?? []) giroIndex.set(g, entry)
  return giroIndex
}

function fromEntry(entry: DirectoryEntry, key: string, confidence: number): DirectoryMatch {
  return {
    key,
    name: entry.name,
    kind: entry.kind,
    country: entry.country ?? null,
    what: entry.what ?? null,
    rail: null,
    logoDomain: entry.logoDomain ?? null,
    confidence,
    source: 'seed',
  }
}

/** The seed entry whose pattern occurs as whole tokens in the text, longest first. */
export function matchSeedText(text: string): DirectoryEntry | null {
  const t = text.toLowerCase()
  const f = fold(text)
  for (const { re, spaced, entry } of compile()) if (re.test(t) || spaced.test(f)) return entry
  return null
}

/**
 * Seed lookup for a pre-cleaned string: a giro number settles it outright;
 * then the sub-merchant of a facilitator string, the cleaned text, the
 * payment-file payee and the domain are tried in that order.
 */
export function matchSeed(pre: Precleaned): DirectoryMatch | null {
  if (pre.giro) {
    const g = giros().get(pre.giro.value)
    if (g) return fromEntry(g, `${pre.giro.scheme}:${pre.giro.value}`, GIRO_CONFIDENCE)
  }
  const texts = [pre.subMerchant, pre.text, pre.lbPayee, pre.domain].filter((s): s is string => !!s)
  for (const t of texts) {
    const entry = matchSeedText(t)
    if (entry) return fromEntry(entry, pre.aliasKey, SEED_CONFIDENCE)
  }
  return null
}

interface DirectoryRow {
  directory_key: string
  display_name: string
  kind: DirectoryKind
  rail: string | null
  country: string | null
  what: string | null
  logo_domain: string | null
  source: 'seed' | 'promoted'
  confidence: number | string
}

export function directoryKeysFor(pre: Precleaned): string[] {
  const keys = [pre.aliasKey]
  if (pre.giro) keys.push(`${pre.giro.scheme}:${pre.giro.value}`)
  if (pre.domain) keys.push(`domain:${pre.domain}`)
  return keys
}

/**
 * Seed first, then the promoted table. Service-role client: the table has no
 * member policies on purpose.
 */
export async function lookupDirectory(service: SupabaseClient, pre: Precleaned): Promise<DirectoryMatch | null> {
  const seed = matchSeed(pre)
  if (seed) return seed
  const keys = directoryKeysFor(pre)
  const { data, error } = await service
    .from('counterparty_directory')
    .select('directory_key, display_name, kind, rail, country, what, logo_domain, source, confidence')
    .in('directory_key', keys)
    .limit(5)
  if (error || !data?.length) return null
  const rows = data as DirectoryRow[]
  // Prefer the most specific key: giro, then domain, then the alias key.
  const order = (k: string) => (k.startsWith('bg:') || k.startsWith('pg:') ? 0 : k.startsWith('domain:') ? 1 : 2)
  rows.sort((a, b) => order(a.directory_key) - order(b.directory_key))
  const r = rows[0]!
  return {
    key: r.directory_key,
    name: r.display_name,
    kind: r.kind,
    country: r.country,
    what: r.what,
    rail: r.rail,
    logoDomain: r.logo_domain,
    confidence: Math.min(Number(r.confidence) || PROMOTED_CONFIDENCE, PROMOTED_CONFIDENCE),
    source: r.source,
  }
}

export interface PromotionCandidate {
  aliasKey: string
  displayName: string
  kind: string
  rail: string | null
  country: string | null
  what: string | null
}

/**
 * Promote a model reading to the shared directory once the same name came
 * out of the same key in enough companies. Counts live alias rows across the
 * fleet, so a reading stays private to one company until another company
 * independently produced it.
 */
export async function promoteIfShared(service: SupabaseClient, c: PromotionCandidate): Promise<boolean> {
  if (!PROMOTABLE_KINDS.has(c.kind)) return false
  const { data, error } = await service
    .from('counterparty_aliases')
    .select('company_id')
    .eq('alias_key', c.aliasKey)
    .eq('display_name', c.displayName)
    .eq('band', 'link')
    .is('superseded_at', null)
    .limit(50)
  if (error || !data) return false
  const companies = new Set((data as Array<{ company_id: string }>).map((r) => r.company_id))
  if (companies.size < PROMOTION_MIN_COMPANIES) return false
  const { error: upsertError } = await service.from('counterparty_directory').upsert(
    {
      directory_key: c.aliasKey,
      display_name: c.displayName,
      kind: c.kind,
      rail: c.rail,
      country: c.country,
      what: c.what,
      source: 'promoted',
      company_count: companies.size,
      confidence: PROMOTED_CONFIDENCE,
    },
    { onConflict: 'directory_key' },
  )
  return !upsertError
}
