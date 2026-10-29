#!/usr/bin/env npx tsx
/**
 * Generate the iXBRL taxonomy concept registries from the official taxonomy
 * material committed in docs/reference/bokslut/taxonomi/.
 *
 * Why generated (not hand-authored):
 *   - Which concepts a report may use, their namespace, balance (debit/
 *     credit), period type and datatype are fixed by the taxonomy. Hand-
 *     copying thousands of rows guarantees drift; a registry must be
 *     reproducible from the committed source.
 *   - Taxonomy versions are data, not code: each version is its own
 *     generated JSON file plus an entry in lib/bokslut/ixbrl/taxonomy/
 *     entry-points.ts, leaving emitters for older versions untouched.
 *
 * Two registries, two kinds of source:
 *
 *   k2-ab-2024-09-12 (rev 2025-03-12), from the official element lists:
 *     - k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx
 *       → one sheet per delrapport (allmän info, FB, RR, BR, noter, ...)
 *     - tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx
 *       → tuple → ordered member model with per-member "obligatorisk" flag
 *     - taxonomi-paket-2024-09-12_rev20250312.zip
 *       → se-comp-base-2020-12-01.xsd for the fastställelseintyg concepts
 *
 *   k3-ab-2021-10-31 (rev 2026-08-31), from the taxonomy package itself:
 *     - taxonomi-paket-2026-08-31.zip, the package Bolagsverket and
 *       taxonomier.se publish (K3 2021-10-31 revised 2026-08-31). Membership
 *       is the union of the presentation linkbases of the forms the K3 AB
 *       risbs entry point imports (fcd, fdr, fscie, fisbn, fbs, fcf, fdisc,
 *       fsign): the K3 forms have no calculation linkbases, so this registry
 *       is the only thing that keeps a concept outside the forms out of a
 *       generated document (mustGetConcept throws on it). Datatype, balance,
 *       period type and abstract come from the concept schemas' element
 *       declarations, labels from their standard Swedish label linkbases,
 *       tuple member order from the tuples' content model.
 *     - the same package's se-comp-base-2020-12-01.xsd for the
 *       fastställelseintyg (COA) concepts.
 *
 * Output: lib/bokslut/ixbrl/taxonomy/generated/<id>.json.
 * Deterministic: concepts sorted by name, no timestamps; --check regenerates
 * every registry in memory and fails (exit 1) when a committed file is
 * stale, mirroring skills:check. CI runs it (npm run taxonomy:check).
 *
 * Usage:
 *   npx tsx scripts/generate-taxonomy-registry.ts          # write registries
 *   npx tsx scripts/generate-taxonomy-registry.ts --check  # CI guard
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

const __filename = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(__filename))
const TAXONOMI_DIR = join(ROOT, 'docs', 'reference', 'bokslut', 'taxonomi')
const DOC_DIR = join(TAXONOMI_DIR, 'dokumentation')
const OUT_DIR = join(ROOT, 'src', 'lib', 'bokslut', 'ixbrl', 'taxonomy', 'generated')

const checkOnly = process.argv.includes('--check')

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
  /** Which delrapporter (element-list sheets, or K3 forms) list the concept. */
  sections: string[]
  /** The only values the schema accepts, when the datatype restricts the
   *  string to an enumeration (the fastställelseintyg sentences and the
   *  företrädarroll). Absent for free values. */
  enumeration?: string[]
}

interface TupleMemberOut {
  name: string
  ns: string
  required: boolean
}

type Tuples = Record<string, { ns: string; members: TupleMemberOut[] }>

interface RegistryOut {
  _meta: {
    taxonomy: string
    version: string
    revision: string
    generator: 'scripts/generate-taxonomy-registry.ts'
    sources: Record<string, string>
    /** Package registries only: the forms whose presentation defines membership. */
    forms?: string[]
    conceptCount: number
    tupleCount: number
  }
  concepts: Record<string, ConceptOut>
  tuples: Tuples
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function cellStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(rec).sort()) out[key] = rec[key]
  return out
}

/** The five XML entities and numeric character references. */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attrOf(attrText: string, name: string): string | null {
  const m = attrText.match(new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, '\\$&')}="([^"]*)"`))
  return m ? m[1] : null
}

/**
 * The fastställelseintyg concepts (se-bol-base) come from Bolagsverket's
 * comp-base schema inside a taxonomy package: they are not in any element
 * list or K3 form. Parse the XSD element declarations directly, plus the
 * enumerated string types several of them use: a value outside such a list
 * is a schema error at Bolagsverket, so the allowed values travel with the
 * concept and the FactWriter refuses anything else at generation time.
 */
function parseCompBase(xsd: string, concepts: Record<string, ConceptOut>): void {
  const enumerations = new Map<string, string[]>()
  for (const [, typeName, body] of xsd.matchAll(
    /<xsd:complexType name="([^"]+)">([\s\S]*?)<\/xsd:complexType>/g,
  )) {
    const values = [...body.matchAll(/<xsd:enumeration value="([^"]*)"\s*\/>/g)].map(
      ([, value]) => value,
    )
    if (values.length > 0) enumerations.set(`se-comp-base:${typeName}`, values)
  }
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
    const dataType = attr('type')
    const enumeration = dataType ? enumerations.get(dataType) : undefined
    concepts[name] = {
      ns: 'se-bol-base',
      label: name,
      abstract: attr('abstract') === 'true',
      dataType,
      balance: null,
      periodType:
        periodType === 'duration' || periodType === 'instant' ? periodType : null,
      kind: subst === 'xbrli:tuple' ? 'tuple' : 'item',
      sections: ['faststallelseintyg'],
      ...(enumeration ? { enumeration } : {}),
    }
  }
}

async function zipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) throw new Error(`${path} missing from taxonomy package`)
  return file.async('string')
}

// ---------------------------------------------------------------------------
// K2 AB 2024-09-12: element lists (unchanged since the registry first shipped)
// ---------------------------------------------------------------------------

const K2_PACKAGE_ZIP = join(TAXONOMI_DIR, 'taxonomi-paket-2024-09-12_rev20250312.zip')
const K2_ELEMENT_LIST = join(DOC_DIR, 'k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx')
const K2_TUPLE_MODEL = join(DOC_DIR, 'tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx')
const K2_COMP_BASE_XSD_ENTRY =
  'taxonomi-paket-2024-09-12_rev20250312/xbrl.taxonomier.se/se/common/base/se-comp-base/2020-12-01/se-comp-base-2020-12-01.xsd'

/** Sheet name (as it appears in the workbook) → registry section key. */
const K2_SHEET_SECTIONS: Record<string, string> = {
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

function parseElementList(): Record<string, ConceptOut> {
  const wb = XLSX.read(readFileSync(K2_ELEMENT_LIST), { type: 'buffer' })
  const concepts: Record<string, ConceptOut> = {}

  for (const sheetName of wb.SheetNames) {
    const section = K2_SHEET_SECTIONS[sheetName]
    if (!section) {
      throw new Error(
        `Unknown sheet "${sheetName}" in element list: add it to K2_SHEET_SECTIONS`,
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

function parseTupleModel(concepts: Record<string, ConceptOut>): Tuples {
  const wb = XLSX.read(readFileSync(K2_TUPLE_MODEL), { type: 'buffer' })
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

  const tuples: Tuples = {}
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

async function buildK2Registry(): Promise<string> {
  const concepts = parseElementList()
  const tuples = parseTupleModel(concepts)
  const zip = await JSZip.loadAsync(readFileSync(K2_PACKAGE_ZIP))
  parseCompBase(await zipText(zip, K2_COMP_BASE_XSD_ENTRY), concepts)

  const registry: RegistryOut = {
    _meta: {
      taxonomy: 'k2-ab',
      version: '2024-09-12',
      revision: '2025-03-12',
      generator: 'scripts/generate-taxonomy-registry.ts',
      sources: {
        'k2-ab-arsredovisning-elementlista-2024-09-12_rev20250312_sv.xlsx':
          sha256(readFileSync(K2_ELEMENT_LIST)),
        'tuple-innehallsmodell-arsredovisning-k2-2024-09-12.xlsx':
          sha256(readFileSync(K2_TUPLE_MODEL)),
        'se-comp-base-2020-12-01.xsd': K2_COMP_BASE_XSD_ENTRY,
      },
      conceptCount: Object.keys(concepts).length,
      tupleCount: Object.keys(tuples).length,
    },
    concepts: sortedRecord(concepts),
    tuples: sortedRecord(tuples),
  }
  return JSON.stringify(registry, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Package registries (K3): forms' presentation linkbases + concept schemas
// ---------------------------------------------------------------------------

interface PackageRegistrySpec {
  taxonomy: string
  version: string
  revision: string
  /** File name inside docs/reference/bokslut/taxonomi/. */
  packageFile: string
  /** Directory inside the zip that maps to http://xbrl.taxonomier.se/. */
  packageRoot: string
  /** Form key → presentation linkbase (path under packageRoot). */
  forms: Record<string, string>
  /** Concept schemas the forms point into: prefix → schema and its standard
   *  Swedish label linkbase (paths under packageRoot). */
  schemas: Record<string, { xsd: string; labels: string }>
  /** se-comp-base schema for the fastställelseintyg (path under packageRoot). */
  compBaseXsd: string
}

const K3_FORM = (form: string): string =>
  `se/fr/gaap/k3/form/se-k3-${form}/2021-10-31/se-k3-${form}-2021-10-31-presentation.xml`

/** The forms se-k3-risbs-2021-10-31.xsd imports, in its order. */
const K3_AB_2021_10_31: PackageRegistrySpec = {
  taxonomy: 'k3-ab',
  version: '2021-10-31',
  revision: '2026-08-31',
  packageFile: 'taxonomi-paket-2026-08-31.zip',
  packageRoot: 'taxonomi-paket-2026-08-31/xbrl.taxonomier.se/',
  forms: Object.fromEntries(
    ['fcd', 'fdr', 'fscie', 'fisbn', 'fbs', 'fcf', 'fdisc', 'fsign'].map((form) => [form, K3_FORM(form)]),
  ),
  schemas: {
    'se-gen-base': {
      xsd: 'se/common/base/se-gen-base/2021-10-31/se-gen-base-2021-10-31.xsd',
      labels: 'se/common/base/se-gen-base/2021-10-31/se-gen-base-2021-10-31-label-std-sv.xml',
    },
    'se-cd-base': {
      xsd: 'se/common/base/se-cd-base/2021-10-31/se-cd-base-2021-10-31.xsd',
      labels: 'se/common/base/se-cd-base/2021-10-31/se-cd-base-2021-10-31-label-std-sv.xml',
    },
    'se-mem-base': {
      xsd: 'se/common/base/se-mem-base/2021-10-31/se-mem-base-2021-10-31.xsd',
      labels: 'se/common/base/se-mem-base/2021-10-31/se-mem-base-2021-10-31-label-std-sv.xml',
    },
    'se-gaap-ext': {
      xsd: 'se/common/domain/gaap/shared/concept/se-gaap-ext/2021-10-31/se-gaap-ext-2021-10-31.xsd',
      labels: 'se/common/domain/gaap/shared/concept/se-gaap-ext/2021-10-31/se-gaap-ext-2021-10-31-label-std-sv.xml',
    },
  },
  compBaseXsd: 'se/common/base/se-comp-base/2020-12-01/se-comp-base-2020-12-01.xsd',
}

interface ElementDecl {
  name: string
  type: string | null
  substitutionGroup: string | null
  periodType: string | null
  balance: string | null
  abstract: boolean
  /** Tuples: the content model's element refs, in order, with minOccurs. */
  members: Array<{ ref: string; minOccurs: number }>
}

/** Every top-level element declaration of a concept schema. */
function parseElementDecls(xsd: string): Map<string, ElementDecl> {
  const decls = new Map<string, ElementDecl>()
  // Self-closing declarations (items) and declarations with a body (tuples).
  const re = /<xsd:element ((?:(?!\/>)[^>])*name="[^"]+"[^>]*?)(\/>|>([\s\S]*?)<\/xsd:element>)/g
  for (const match of xsd.matchAll(re)) {
    const attrText = match[1]
    const body = match[3] ?? ''
    const name = attrOf(attrText, 'name')
    if (!name) continue
    const members = [...body.matchAll(/<xsd:element ([^>]*?)\/>/g)].map(([, memberAttrs]) => ({
      ref: attrOf(memberAttrs, 'ref') ?? '',
      minOccurs: Number(attrOf(memberAttrs, 'minOccurs') ?? '1'),
    }))
    decls.set(name, {
      name,
      type: attrOf(attrText, 'type'),
      substitutionGroup: attrOf(attrText, 'substitutionGroup'),
      periodType: attrOf(attrText, 'xbrli:periodType'),
      balance: attrOf(attrText, 'xbrli:balance'),
      abstract: attrOf(attrText, 'abstract') === 'true',
      members: members.filter((member) => member.ref.length > 0),
    })
  }
  return decls
}

/** Standard labels (role http://www.xbrl.org/2003/role/label) by concept id. */
function parseStandardLabels(linkbase: string): Map<string, string> {
  const locs = new Map<string, string>() // loc label → concept id
  for (const [, attrs] of linkbase.matchAll(/<link:loc ([^>]*?)\/?>/g)) {
    const href = attrOf(attrs, 'xlink:href')
    const label = attrOf(attrs, 'xlink:label')
    if (href && label) locs.set(label, href.slice(href.indexOf('#') + 1))
  }
  const resources = new Map<string, string>() // resource label → text
  for (const [, attrs, text] of linkbase.matchAll(/<link:label ([^>]*?)>([\s\S]*?)<\/link:label>/g)) {
    if (attrOf(attrs, 'xlink:role') !== 'http://www.xbrl.org/2003/role/label') continue
    const label = attrOf(attrs, 'xlink:label')
    if (label) resources.set(label, decodeXml(text.trim()))
  }
  const labels = new Map<string, string>()
  for (const [, attrs] of linkbase.matchAll(/<link:labelArc ([^>]*?)\/?>/g)) {
    const from = attrOf(attrs, 'xlink:from')
    const to = attrOf(attrs, 'xlink:to')
    const id = from ? locs.get(from) : undefined
    const text = to ? resources.get(to) : undefined
    if (id && text !== undefined && !labels.has(id)) labels.set(id, text)
  }
  return labels
}

/** Concept ids ("se-gen-base_Nettoomsattning") a presentation linkbase points at. */
function presentationConcepts(linkbase: string, linkbasePath: string, spec: PackageRegistrySpec): string[] {
  const ids = new Set<string>()
  for (const [, attrs] of linkbase.matchAll(/<link:loc ([^>]*?)\/?>/g)) {
    const href = attrOf(attrs, 'xlink:href')
    if (!href) continue
    const [file, id] = href.split('#')
    const resolved = posix.normalize(posix.join(posix.dirname(linkbasePath), file))
    // Role schemas name the form's extended link role, never a concept.
    if (/\/role\//.test(resolved)) continue
    const prefix = Object.entries(spec.schemas).find(([, schema]) => schema.xsd === resolved)?.[0]
    if (!prefix) {
      throw new Error(`${linkbasePath} points into ${resolved}, which is not a known concept schema: add it to the spec`)
    }
    if (!id.startsWith(`${prefix}_`)) throw new Error(`${linkbasePath}: id ${id} does not belong to ${prefix}`)
    ids.add(id)
  }
  return [...ids]
}

function conceptFromDecl(prefix: string, decl: ElementDecl, label: string | undefined, sections: string[]): ConceptOut {
  const isTuple = decl.substitutionGroup === 'xbrli:tuple'
  return {
    ns: prefix,
    label: label ?? decl.name,
    abstract: decl.abstract,
    dataType: isTuple ? null : decl.type,
    balance: decl.balance === 'debit' || decl.balance === 'credit' ? decl.balance : null,
    periodType: decl.periodType === 'duration' || decl.periodType === 'instant' ? decl.periodType : null,
    kind: isTuple ? 'tuple' : 'item',
    sections,
  }
}

async function buildPackageRegistry(spec: PackageRegistrySpec): Promise<string> {
  const packagePath = join(TAXONOMI_DIR, spec.packageFile)
  const packageBytes = readFileSync(packagePath)
  const zip = await JSZip.loadAsync(packageBytes)
  const read = (path: string) => zipText(zip, spec.packageRoot + path)

  const declsByPrefix = new Map<string, Map<string, ElementDecl>>()
  const labelsByPrefix = new Map<string, Map<string, string>>()
  for (const [prefix, schema] of Object.entries(spec.schemas)) {
    declsByPrefix.set(prefix, parseElementDecls(await read(schema.xsd)))
    labelsByPrefix.set(prefix, parseStandardLabels(await read(schema.labels)))
  }

  const concepts: Record<string, ConceptOut> = {}
  const add = (prefix: string, name: string, section: string): ConceptOut => {
    const existing = concepts[name]
    if (existing) {
      if (existing.ns !== prefix) {
        throw new Error(`Concept ${name} is declared in both ${existing.ns} and ${prefix}: the registry is keyed by local name`)
      }
      if (!existing.sections.includes(section)) existing.sections.push(section)
      return existing
    }
    const decl = declsByPrefix.get(prefix)?.get(name)
    if (!decl) throw new Error(`Concept ${prefix}:${name} has no declaration in ${spec.schemas[prefix]?.xsd}`)
    const concept = conceptFromDecl(prefix, decl, labelsByPrefix.get(prefix)?.get(`${prefix}_${name}`), [section])
    concepts[name] = concept
    return concept
  }

  for (const [form, path] of Object.entries(spec.forms)) {
    for (const id of presentationConcepts(await read(path), path, spec)) {
      const separator = id.indexOf('_')
      add(id.slice(0, separator), id.slice(separator + 1), form)
    }
  }

  // Tuples of the forms with their content model, in schema order. A member
  // the presentation leaves out still has to be emittable inside its tuple.
  const tuples: Tuples = {}
  for (const [name, concept] of Object.entries({ ...concepts })) {
    if (concept.kind !== 'tuple') continue
    const decl = declsByPrefix.get(concept.ns)?.get(name)
    tuples[name] = {
      ns: concept.ns,
      members: (decl?.members ?? []).map((member) => {
        const [memberPrefix, memberName] = member.ref.split(':')
        add(memberPrefix, memberName, 'tuple-model')
        return { name: memberName, ns: memberPrefix, required: member.minOccurs > 0 }
      }),
    }
  }

  parseCompBase(await read(spec.compBaseXsd), concepts)

  const registry: RegistryOut = {
    _meta: {
      taxonomy: spec.taxonomy,
      version: spec.version,
      revision: spec.revision,
      generator: 'scripts/generate-taxonomy-registry.ts',
      sources: { [spec.packageFile]: sha256(packageBytes) },
      forms: Object.keys(spec.forms),
      conceptCount: Object.keys(concepts).length,
      tupleCount: Object.keys(tuples).length,
    },
    concepts: sortedRecord(concepts),
    tuples: sortedRecord(tuples),
  }
  return JSON.stringify(registry, null, 2) + '\n'
}

// ---------------------------------------------------------------------------

const REGISTRIES: Array<{ file: string; build: () => Promise<string> }> = [
  { file: 'k2-ab-2024-09-12.json', build: buildK2Registry },
  { file: 'k3-ab-2021-10-31.json', build: () => buildPackageRegistry(K3_AB_2021_10_31) },
]

async function main(): Promise<void> {
  let stale = false
  for (const target of REGISTRIES) {
    const outPath = join(OUT_DIR, target.file)
    const json = await target.build()
    if (checkOnly) {
      const committed = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null
      if (committed !== json) {
        console.error(
          `Taxonomy registry is stale: ${outPath} does not match its taxonomy source.\n` +
            'Run: npx tsx scripts/generate-taxonomy-registry.ts',
        )
        stale = true
      }
      continue
    }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, json, 'utf8')
    const parsed = JSON.parse(json) as RegistryOut
    console.log(
      `Wrote ${outPath} (${parsed._meta.conceptCount} concepts, ${parsed._meta.tupleCount} tuples)`,
    )
  }
  if (stale) process.exit(1)
  if (checkOnly) console.log('Taxonomy registries are up to date.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
