#!/usr/bin/env npx tsx
/**
 * Generate the iXBRL taxonomy concept registry from the official Bolagsverket/
 * taxonomier.se element lists in dev_docs/bokslut/taxonomi/dokumentation/.
 *
 * Why generated (not hand-authored):
 *   - The element lists (xlsx) are the official mapping spec for which concepts
 *     exist per delrapport, their namespace, balance (debit/credit) and period
 *     type. Hand-copying ~1 300 rows guarantees drift; the registry must be
 *     reproducible from the committed spec files.
 *   - The September 2026 taxonomy generation replaces tuples with dimensions:
 *     taxonomy versions are data, not code. New versions become new generated
 *     JSON files + a new entry in lib/bokslut/ixbrl/taxonomy/entry-points.ts,
 *     leaving emitters for older versions untouched.
 *
 * Sources (committed in dev_docs/bokslut/):
 *   - k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx
 *     → one sheet per delrapport (allmän info, FB, RR, BR, noter, underskrifter…)
 *   - tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx
 *     → tuple → ordered member model with per-member "obligatorisk" flag
 *   - taxonomi-paket-2024-09-12_rev20250312.zip
 *     → se-comp-base-2020-12-01.xsd parsed for the fastställelseintyg concepts
 *       (se-bol-base), which are not part of any element list
 *
 * Output: lib/bokslut/ixbrl/taxonomy/generated/k2-ab-2024-09-12.json
 * Deterministic: concepts sorted by name, no timestamps; --check regenerates
 * in memory and fails (exit 1) when the committed file is stale, mirroring
 * skills:check.
 *
 * Usage:
 *   npx tsx scripts/generate-taxonomy-registry.ts          # write registry
 *   npx tsx scripts/generate-taxonomy-registry.ts --check  # CI guard
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))
const DOC_DIR = join(ROOT, 'dev_docs', 'bokslut', 'taxonomi', 'dokumentation')
const PACKAGE_ZIP = join(
  ROOT,
  'dev_docs',
  'bokslut',
  'taxonomi',
  'taxonomi-paket-2024-09-12_rev20250312.zip',
)
const ELEMENT_LIST = join(
  DOC_DIR,
  'k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx',
)
const TUPLE_MODEL = join(
  DOC_DIR,
  'tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx',
)
const COMP_BASE_XSD_ENTRY =
  'taxonomi-paket-2024-09-12_rev20250312/xbrl.taxonomier.se/se/common/base/se-comp-base/2020-12-01/se-comp-base-2020-12-01.xsd'

const OUT_PATH = join(
  ROOT,
  'lib',
  'bokslut',
  'ixbrl',
  'taxonomy',
  'generated',
  'k2-ab-2024-09-12.json',
)

const checkOnly = process.argv.includes('--check')

/** Sheet name (as it appears in the workbook) → registry section key. */
const SHEET_SECTIONS: Record<string, string> = {
  'Allmän information': 'allman-information',
  'Förvaltningsberättelse': 'forvaltningsberattelse',
  'Kostnadsslagsindelad resultatr': 'rr-kostnadsslagsindelad',
  'Förkortad kostnadsslagsindelad': 'rr-kostnadsslagsindelad-forkortad',
  'Balansräkning': 'balansrakning',
  'Förkortad balansräkning': 'balansrakning-forkortad',
  'Kassaflödesanalys indirekt met': 'kassaflodesanalys',
  'Noter': 'noter',
  // Trailing space is present in the workbook sheet name.
  'Undertecknande av företrädare ': 'undertecknande',
}

interface ConceptOut {
  /** Namespace prefix, e.g. "se-gen-base". Resolved to a URI in entry-points.ts. */
  ns: string
  /** Standardrubrik: the official presentation label. */
  label: string
  abstract: boolean
  /** XBRL datatype, e.g. "xbrli:monetaryItemType". Null for tuples. */
  dataType: string | null
  balance: 'debit' | 'credit' | null
  periodType: 'duration' | 'instant' | null
  kind: 'item' | 'tuple'
  /** Which delrapporter (sheets) list the concept. */
  sections: string[]
}

interface TupleMemberOut {
  name: string
  ns: string
  required: boolean
}

interface RegistryOut {
  _meta: {
    taxonomy: 'k2-ab'
    version: '2024-09-12'
    revision: '2025-03-12'
    generator: 'scripts/generate-taxonomy-registry.ts'
    sources: Record<string, string>
    conceptCount: number
    tupleCount: number
  }
  concepts: Record<string, ConceptOut>
  tuples: Record<string, { ns: string; members: TupleMemberOut[] }>
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function cellStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function parseElementList(): Record<string, ConceptOut> {
  const wb = XLSX.read(readFileSync(ELEMENT_LIST), { type: 'buffer' })
  const concepts: Record<string, ConceptOut> = {}

  for (const sheetName of wb.SheetNames) {
    const section = SHEET_SECTIONS[sheetName]
    if (!section) {
      throw new Error(
        `Unknown sheet "${sheetName}" in element list: add it to SHEET_SECTIONS`,
      )
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
      header: 1,
      blankrows: false,
    })
    const header = rows[0] as (string | null)[]
    const col = (label: string): number => {
      const i = header.indexOf(label)
      if (i === -1)
        throw new Error(`Column "${label}" missing on sheet "${sheetName}"`)
      return i
    }
    const iEl = col('Elementnamn')
    const iNs = col('Tillhör')
    const iLabel = col('Standardrubrik')
    const iAbstract = col('Abstrakt')
    const iDataType = col('Datatyp')
    const iBalance = col('Saldo')
    const iPeriodType = col('Periodtyp')
    const iKind = col('Typ')

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      const name = cellStr(row[iEl])
      if (!name) continue
      const ns = cellStr(row[iNs])
      if (!ns) throw new Error(`Row ${r} on "${sheetName}": missing Tillhör for ${name}`)
      const balanceRaw = cellStr(row[iBalance])
      const periodRaw = cellStr(row[iPeriodType])
      const kindRaw = cellStr(row[iKind])
      const parsed: ConceptOut = {
        ns,
        label: cellStr(row[iLabel]) ?? name,
        abstract: cellStr(row[iAbstract]) === 'true',
        dataType: cellStr(row[iDataType]),
        balance:
          balanceRaw === 'debit' || balanceRaw === 'credit' ? balanceRaw : null,
        periodType:
          periodRaw === 'duration' || periodRaw === 'instant' ? periodRaw : null,
        kind: kindRaw === 'tuple' ? 'tuple' : 'item',
        sections: [section],
      }
      const existing = concepts[name]
      if (existing) {
        // Same element listed on several sheets (shared concepts). Attribute
        // mismatches would mean the spec disagrees with itself: fail loudly.
        for (const key of ['ns', 'dataType', 'balance', 'periodType', 'kind'] as const) {
          if (existing[key] !== parsed[key]) {
            throw new Error(
              `Concept ${name}: "${String(key)}" differs between sheets (${String(existing[key])} vs ${String(parsed[key])})`,
            )
          }
        }
        if (!existing.sections.includes(section)) existing.sections.push(section)
      } else {
        concepts[name] = parsed
      }
    }
  }
  return concepts
}

function parseTupleModel(
  concepts: Record<string, ConceptOut>,
): Record<string, { ns: string; members: TupleMemberOut[] }> {
  const wb = XLSX.read(readFileSync(TUPLE_MODEL), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    blankrows: false,
  })
  // Row 0 is a super-header ("Obligatoriskt värde i Tuple" lives at index 12);
  // row 1 holds the real column labels.
  const header = rows[1] as (string | null)[]
  const iNs = header.indexOf('Tillhör')
  const iEl = header.indexOf('Elementnamn')
  const iKind = header.indexOf('Typ')
  const iAb = header.indexOf('AB')
  const iRequired = 12
  if (iNs === -1 || iEl === -1 || iKind === -1 || iAb === -1) {
    throw new Error('Tuple model columns moved: update parseTupleModel')
  }

  const tuples: Record<string, { ns: string; members: TupleMemberOut[] }> = {}
  let current: { name: string; inAb: boolean } | null = null
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r]
    const name = cellStr(row[iEl])
    if (!name) continue
    const kind = cellStr(row[iKind])
    const ns = cellStr(row[iNs]) ?? 'se-gaap-ext'
    if (kind === 'xbrli:tuple') {
      const inAb = cellStr(row[iAb]) === 'JA'
      current = { name, inAb }
      if (inAb) tuples[name] = { ns, members: [] }
    } else if (kind === 'xbrli:item' && current?.inAb) {
      tuples[current.name].members.push({
        name,
        ns,
        required: cellStr(row[iRequired]) === 'JA',
      })
    }
  }

  // Tuples used by K2 AB must also exist as concepts (the element list carries
  // the ones that appear in the K2 AB report; the tuple model spans all
  // company forms). Members referenced but missing from the element list are
  // added as items so the registry is self-contained.
  for (const [name, t] of Object.entries(tuples)) {
    if (!concepts[name]) {
      concepts[name] = {
        ns: t.ns,
        label: name,
        abstract: false,
        dataType: null,
        balance: null,
        periodType: null,
        kind: 'tuple',
        sections: ['tuple-model'],
      }
    }
    for (const m of t.members) {
      if (!concepts[m.name]) {
        concepts[m.name] = {
          ns: m.ns,
          label: m.name,
          abstract: false,
          dataType: 'xbrli:stringItemType',
          balance: null,
          periodType: 'duration',
          kind: 'item',
          sections: ['tuple-model'],
        }
      }
    }
  }
  return tuples
}

/**
 * The fastställelseintyg concepts (se-bol-base) come from Bolagsverket's
 * comp-base schema inside the taxonomy package: they are not in any element
 * list. Parse the XSD element declarations directly.
 */
async function parseCompBase(concepts: Record<string, ConceptOut>): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(PACKAGE_ZIP))
  const file = zip.file(COMP_BASE_XSD_ENTRY)
  if (!file) throw new Error(`${COMP_BASE_XSD_ENTRY} missing from taxonomy package`)
  const xsd = await file.async('string')
  const decls = xsd.matchAll(/<xsd:element ([^>]*)\/>/g)
  for (const [, attrText] of decls) {
    const attr = (n: string): string | null => {
      const m = attrText.match(new RegExp(`${n}="([^"]*)"`))
      return m ? m[1] : null
    }
    const name = attr('name')
    if (!name) continue
    const subst = attr('substitutionGroup')
    const periodType = attr('xbrli:periodType')
    concepts[name] = {
      ns: 'se-bol-base',
      label: name,
      abstract: attr('abstract') === 'true',
      dataType: attr('type'),
      balance: null,
      periodType:
        periodType === 'duration' || periodType === 'instant' ? periodType : null,
      kind: subst === 'xbrli:tuple' ? 'tuple' : 'item',
      sections: ['faststallelseintyg'],
    }
  }
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(rec).sort()) out[key] = rec[key]
  return out
}

async function buildRegistry(): Promise<string> {
  const concepts = parseElementList()
  const tuples = parseTupleModel(concepts)
  await parseCompBase(concepts)

  const registry: RegistryOut = {
    _meta: {
      taxonomy: 'k2-ab',
      version: '2024-09-12',
      revision: '2025-03-12',
      generator: 'scripts/generate-taxonomy-registry.ts',
      sources: {
        'k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx':
          sha256(readFileSync(ELEMENT_LIST)),
        'tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx':
          sha256(readFileSync(TUPLE_MODEL)),
        'se-comp-base-2020-12-01.xsd': COMP_BASE_XSD_ENTRY,
      },
      conceptCount: Object.keys(concepts).length,
      tupleCount: Object.keys(tuples).length,
    },
    concepts: sortedRecord(concepts),
    tuples: sortedRecord(tuples),
  }
  return JSON.stringify(registry, null, 2) + '\n'
}

async function main(): Promise<void> {
  const json = await buildRegistry()
  if (checkOnly) {
    const committed = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null
    if (committed !== json) {
      console.error(
        `Taxonomy registry is stale: ${OUT_PATH} does not match the element lists.\n` +
          'Run: npx tsx scripts/generate-taxonomy-registry.ts',
      )
      process.exit(1)
    }
    console.log('Taxonomy registry is up to date.')
    return
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, json, 'utf8')
  const parsed = JSON.parse(json) as RegistryOut
  console.log(
    `Wrote ${OUT_PATH} (${parsed._meta.conceptCount} concepts, ${parsed._meta.tupleCount} tuples)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
