/**
 * Law references (lagrum) as keys.
 *
 * Text across the repository cites Swedish law as free text: "ML 17 kap.
 * 24 §", "26 kap. 2 § första stycket SFL", "ÅRL 3:4 §", "16 a § semesterlagen",
 * "BFNAR 2013:2 punkt 4.3", "HFD 2023 ref. 45". parseLawRefs() reads those
 * citations and gives each provision one key, so every spelling of the same
 * provision lands on the same key:
 *
 *   sfs:2023:200#K17P24S2N3   SFS number, then kapitel, paragraf, stycke, punkt
 *   sfs:1977:480#P16a         a law without chapters
 *   sfs:1999:1078#K3          a whole chapter
 *   sfs:2026:100              a whole law or amendment
 *   bfnar:2013:2#4.3          BFN allmänt råd and its punkt
 *   hfd:2023:45  hfd-not:2023:12  ra:2009:1  nja:2015:180
 *   prop:2025/26:66  sou:2023:12
 *
 * The key holds the SFS number, never the abbreviation: "ML" names 1994:200
 * before 2023-07-01 and 2023:200 after, and LAWS maps today's abbreviations.
 * The fragment after # is the anchor lagen.nu and riksdagen.se use (K kapitel,
 * P paragraf, S stycke, N punkt), so an SFS key is also a link.
 * `npm run law:refs` lists what cites a provision, and with --unresolved the
 * locations ("4 kap. 4 §") that name no law we know.
 */

// Laws we cite, by SFS number. `abbr` are the short forms written in our text
// (case-sensitive, whole words); `names` are the stems of the full names
// (lower or upper case first letter, with or without the definite -en/-ens).
export const LAWS = [
  { sfs: '2023:200', title: 'Mervärdesskattelag (2023:200)', abbr: ['ML', 'NML'], names: ['mervärdesskattelag'] },
  { sfs: '1994:200', title: 'Mervärdesskattelag (1994:200), upphävd', abbr: ['GML'], names: [] },
  { sfs: '1999:1078', title: 'Bokföringslag (1999:1078)', abbr: ['BFL'], names: ['bokföringslag'] },
  { sfs: '1995:1554', title: 'Årsredovisningslag (1995:1554)', abbr: ['ÅRL', 'ARL'], names: ['årsredovisningslag'] },
  { sfs: '2011:1244', title: 'Skatteförfarandelag (2011:1244)', abbr: ['SFL'], names: ['skatteförfarandelag'] },
  { sfs: '2011:1261', title: 'Skatteförfarandeförordning (2011:1261)', abbr: ['SFF'], names: ['skatteförfarandeförordning'] },
  { sfs: '1999:1229', title: 'Inkomstskattelag (1999:1229)', abbr: ['IL'], names: ['inkomstskattelag'] },
  { sfs: '2005:551', title: 'Aktiebolagslag (2005:551)', abbr: ['ABL'], names: ['aktiebolagslag'] },
  { sfs: '2000:980', title: 'Socialavgiftslag (2000:980)', abbr: ['SAL'], names: ['socialavgiftslag'] },
  { sfs: '1977:480', title: 'Semesterlag (1977:480)', abbr: ['SemL'], names: ['semesterlag'] },
  { sfs: '1991:1047', title: 'Lag (1991:1047) om sjuklön', abbr: ['SjLL'], names: ['sjuklönelag'] },
  { sfs: '2018:672', title: 'Lag (2018:672) om ekonomiska föreningar', abbr: ['EFL'], names: [] },
  { sfs: '1991:614', title: 'Bostadsrättslag (1991:614)', abbr: ['BRL'], names: ['bostadsrättslag'] },
  { sfs: '1980:1102', title: 'Lag (1980:1102) om handelsbolag och enkla bolag', abbr: ['HBL'], names: [] },
  { sfs: '2017:30', title: 'Hälso- och sjukvårdslag (2017:30)', abbr: ['HSL'], names: ['hälso- och sjukvårdslag'] },
  { sfs: '2010:659', title: 'Patientsäkerhetslag (2010:659)', abbr: ['PSL'], names: ['patientsäkerhetslag'] },
  { sfs: '2022:1681', title: 'Lag (2022:1681) om plattformsoperatörers inhämtande av vissa uppgifter', abbr: ['POL'], names: [] },
  { sfs: '2009:194', title: 'Lag (2009:194) om förfarandet vid skattereduktion för hushållsarbete', abbr: ['HUSFL'], names: [] },
  { sfs: '1970:994', title: 'Jordabalk (1970:994)', abbr: ['JB'], names: ['jordabalk'] },
  { sfs: '1962:700', title: 'Brottsbalk (1962:700)', abbr: ['BrB'], names: ['brottsbalk'] },
  { sfs: '2010:1622', title: 'Alkohollag (2010:1622)', abbr: [], names: ['alkohollag'] },
]

const STYCKE_WORDS = ['första', 'andra', 'tredje', 'fjärde', 'femte', 'sjätte', 'sjunde', 'åttonde', 'nionde', 'tionde']

// \b is ASCII-only in JavaScript, so "ÅRL" would never sit on a boundary.
const B0 = String.raw`(?<![\p{L}\p{N}_])`
const B1 = String.raw`(?![\p{L}\p{N}_])`
const NUM = String.raw`\d{1,3}(?: ?[a-z](?![\p{L}]))?`
const STY = String.raw`(?:,? ?(?:(${STYCKE_WORDS.join('|')}) stycket|(\d{1,2}) st\.?(?![\p{L}])))?`
const PKT = String.raw`(?:,? ?(?:(\d{1,2}) ?p\.|punkt(?:en)? (\d{1,2})))?`
const SECTIONS = String.raw`(${NUM}(?: ?(?:-|\u2013|och|,| to ) ?${NUM})*) ?§§?`
// "17 kap. 24 §", "17 kap.", "24 §", or the colon form "17:24 §".
const LOC = String.raw`(?:(${NUM}(?: ?(?:-|\u2013|och|,) ?${NUM})*) ?kap(?:\.|itlet)?(?: ?${SECTIONS})?|${SECTIONS}|(\d{1,3}):(${NUM})(?: ?§)?(?![\d:]))${STY}${PKT}`

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LAW_BY_TOKEN = new Map()
for (const law of LAWS) {
  for (const a of law.abbr) LAW_BY_TOKEN.set(a, law)
  for (const n of law.names) LAW_BY_TOKEN.set(n.toLowerCase(), law)
}
const ABBR_ALT = LAWS.flatMap((l) => l.abbr).map(escape).join('|')
const NAME_ALT = LAWS.flatMap((l) => l.names)
  .map((n) => `[${n[0]}${n[0].toUpperCase()}]${escape(n.slice(1))}`)
  .join('|')
// A law: an abbreviation, a full name (optionally followed by its SFS
// number), or "lag (2026:100)" / "förordning (2011:1261)".
const LAW = String.raw`(?:${B0}(${ABBR_ALT})(?: ?\((\d{4}:\d{1,4})\))?${B1}|${B0}(${NAME_ALT})(?:ens|en)?(?: \((\d{4}:\d{1,4})\))?${B1}|${B0}(?:[Ll]ag|[Ll]agen|[Ff]örordning|[Ff]örordningen) \((\d{4}:\d{1,4})\))`
const LAW_GROUPS = 5
const LOC_GROUPS = 9

const LAW_FIRST = new RegExp(String.raw`${LAW},? ${LOC}`, 'gu')
// A law followed by a location starts a citation of its own ("..., SFL 17 kap."),
// so it is not the law of the location before it.
const LOC_START = String.raw`(?:\d{1,3}(?: ?[a-z])? ?(?:kap|§)|\d{1,3}:\d)`
const LOC_FIRST = new RegExp(String.raw`${B0}${LOC},? (?:i |enligt |of )?${LAW}(?!,? ${LOC_START})`, 'gu')
// "ML 17 kap. 24 §, 17 kap. 25 §": a further location in the same list takes
// the law named first, unless a law of its own follows it.
const LIST_NEXT = new RegExp(String.raw`((?: ?[,;+]| och| samt) ?)${LOC}(?![. ]*\d)`, 'uy')
// Anything shaped like a location, for the unresolved count.
const LOC_ANY = new RegExp(String.raw`${B0}(?:\d{1,3}(?: ?[a-z])? ?kap(?:\.|itlet)?|\d{1,3}(?: ?[a-z])? ?§)`, 'gu')

const OTHER_SOURCES = [
  { kind: 'bfnar', re: /BFNAR ?(\d{4}):(\d{1,2})(?:,? (?:punkt|p\.) ?(\d{1,2}(?:\.\d{1,2})*[A-Z]?))?/gu, key: (m) => `bfnar:${m[1]}:${m[2]}${m[3] ? `#${m[3]}` : ''}` },
  { kind: 'hfd', re: /HFD (\d{4}) ref\.? ?(\d{1,3})(?!\d)/gu, key: (m) => `hfd:${m[1]}:${m[2]}` },
  { kind: 'hfd-not', re: /HFD (\d{4}) not\.? ?(\d{1,3})(?!\d)/gu, key: (m) => `hfd-not:${m[1]}:${m[2]}` },
  { kind: 'ra', re: /RÅ ?(\d{4}) ref\.? ?(\d{1,3})(?!\d)/gu, key: (m) => `ra:${m[1]}:${m[2]}` },
  { kind: 'nja', re: /NJA (\d{4}) s\.? ?(\d{1,4})(?!\d)/gu, key: (m) => `nja:${m[1]}:${m[2]}` },
  { kind: 'prop', re: /[Pp]rop\.? ?(\d{4}\/\d{2}):(\d{1,3})(?!\d)/gu, key: (m) => `prop:${m[1]}:${m[2]}` },
  { kind: 'sou', re: /SOU (\d{4}):(\d{1,3})(?!\d)/gu, key: (m) => `sou:${m[1]}:${m[2]}` },
  { kind: 'sfs', re: /SFS (\d{4}):(\d{1,4})(?!\d)/gu, key: (m) => `sfs:${m[1]}:${m[2]}` },
]

/** Markdown emphasis and code ticks between a law and its location. */
const stripMarkup = (text) => text.replace(/\*\*|__|\*|`/g, '')

function lawOf(abbr, abbrSfs, name, nameSfs, sfs) {
  const explicit = abbrSfs ?? nameSfs ?? sfs
  if (explicit) return LAWS.find((l) => l.sfs === explicit) ?? { sfs: explicit, title: `SFS ${explicit}`, abbr: [], names: [] }
  if (abbr) return LAW_BY_TOKEN.get(abbr) ?? null
  if (name) return LAW_BY_TOKEN.get(name.toLowerCase()) ?? null
  return null
}

function expandSections(text) {
  if (!text) return [null]
  const out = []
  for (const part of text.split(/ ?(?:och|,) ?/)) {
    const range = part.match(/^(\d{1,3}) ?(?:-|\u2013| to ) ?(\d{1,3})$/)
    const from = range ? Number(range[1]) : 0
    const to = range ? Number(range[2]) : 0
    if (range && to > from && to - from <= 30) {
      for (let n = from; n <= to; n++) out.push(String(n))
    } else {
      out.push(part.split(/ ?(?:-|\u2013| to ) ?/)[0].replace(/ /g, ''))
    }
  }
  return out
}

/** The key of one provision: `sfs:2023:200#K17P24S2N3`. */
export function sfsKey({ sfs, chapter, section, stycke, punkt }) {
  let fragment = ''
  if (chapter) fragment += `K${chapter}`
  if (section) fragment += `P${section}`
  if (section && stycke) fragment += `S${stycke}`
  if (section && punkt) fragment += `N${punkt}`
  return `sfs:${sfs}${fragment ? `#${fragment}` : ''}`
}

/**
 * A link to the text a key names on lagen.nu, or null when we have no
 * address for it. An allmänt råd links to the whole råd: its punkter have no
 * stable anchor there.
 */
export function lawRefUrl(key) {
  const kind = key.slice(0, key.indexOf(':'))
  const rest = key.slice(key.indexOf(':') + 1)
  if (kind === 'sfs') return `https://lagen.nu/${rest}`
  if (kind === 'hfd') return `https://lagen.nu/dom/hfd/${rest}`
  if (kind === 'bfnar') return `https://lagen.nu/bfnar/${rest.split('#')[0]}`
  if (kind === 'prop') return `https://lagen.nu/prop/${rest}`
  return null
}

/**
 * Every citation in a piece of text, one entry per provision named, with
 * `start` and `end` offsets into the text after markup is stripped.
 */
export function parseLawRefs(input) {
  const text = stripMarkup(input)
  const found = []
  const seen = new Set()
  const pushSfs = (law, loc, start, raw) => {
    if (!law) return
    const [chap, secA, secB, colonChap, colonSec, styWord, styNum, p1, p2] = loc
    const stycke = styWord ? STYCKE_WORDS.indexOf(styWord) + 1 : styNum ? Number(styNum) : null
    const punkt = p1 ?? p2 ? Number(p1 ?? p2) : null
    const sections = colonSec ? colonSec.replace(/ /g, '') : (secA ?? secB)
    // A chapter range names whole chapters; sections go with a single chapter.
    const chapters = chap ? expandSections(chap) : [colonChap ?? null]
    const pairs = chapters.length > 1
      ? chapters.map((c) => [c, null])
      : expandSections(sections).map((s) => [chapters[0], s])
    for (const [chapter, section] of pairs) {
      const ref = { kind: 'sfs', sfs: law.sfs, chapter, section, stycke, punkt }
      const key = sfsKey(ref)
      if (seen.has(`${start}:${key}`)) continue
      seen.add(`${start}:${key}`)
      found.push({ ...ref, key, law: law.title, start, end: start + raw.length, raw })
    }
  }
  const locFirst = [...text.matchAll(LOC_FIRST)]
  const ownLawAt = new Set(locFirst.map((m) => m.index))
  for (const m of text.matchAll(LAW_FIRST)) {
    const law = lawOf(...m.slice(1, 1 + LAW_GROUPS))
    pushSfs(law, m.slice(1 + LAW_GROUPS, 1 + LAW_GROUPS + LOC_GROUPS), m.index, m[0])
    LIST_NEXT.lastIndex = m.index + m[0].length
    for (let next = LIST_NEXT.exec(text); next && law; next = LIST_NEXT.exec(text)) {
      // The list ends where a location names a law of its own.
      if (ownLawAt.has(next.index + next[1].length)) break
      pushSfs(law, next.slice(2, 2 + LOC_GROUPS), next.index, next[0])
    }
  }
  for (const m of locFirst) {
    const loc = m.slice(1, 1 + LOC_GROUPS)
    const law = m.slice(1 + LOC_GROUPS, 1 + LOC_GROUPS + LAW_GROUPS)
    pushSfs(lawOf(...law), loc, m.index, m[0])
  }
  for (const source of OTHER_SOURCES) {
    for (const m of text.matchAll(source.re)) {
      const key = source.key(m)
      if (seen.has(`${m.index}:${key}`)) continue
      seen.add(`${m.index}:${key}`)
      const law = source.kind === 'sfs' ? { sfs: `${m[1]}:${m[2]}`, chapter: null, section: null, stycke: null, punkt: null } : {}
      found.push({ kind: source.kind, ...law, key, start: m.index, end: m.index + m[0].length, raw: m[0] })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * Locations in the text ("4 kap. 4 §", "24 §") that no parsed citation
 * covers: the law they belong to is not named next to them, or is not in
 * LAWS. Each is returned with its offset.
 */
export function findUnresolvedLocations(input) {
  const text = stripMarkup(input)
  const refs = parseLawRefs(input)
  const out = []
  for (const m of text.matchAll(LOC_ANY)) {
    if (refs.some((r) => m.index >= r.start && m.index < r.end)) continue
    out.push({ start: m.index, raw: m[0] })
  }
  return out
}

const SFS_KEY_RE = /^sfs:(\d{4}:\d{1,4})(?:#(?:K(\d{1,3}[a-z]?))?(?:P(\d{1,3}[a-z]?))?(?:S(\d{1,2}))?(?:N(\d{1,2}))?)?$/

/**
 * What a search asks for: a citation as written ("SFL 26 kap 2 §"), a key
 * ("sfs:2011:1244#K26P2", "bfnar:2013:2"), or a law on its own ("ML",
 * "bokföringslagen"). Null when the text is none of those.
 */
export function parseLawQuery(input) {
  const text = input.trim()
  const key = text.match(SFS_KEY_RE)
  if (key) {
    const [, sfs, chapter, section, stycke, punkt] = key
    const ref = { kind: 'sfs', sfs, chapter: chapter ?? null, section: section ?? null, stycke: stycke ? Number(stycke) : null, punkt: punkt ? Number(punkt) : null }
    return { ...ref, key: sfsKey(ref) }
  }
  const other = text.match(/^([a-z-]+):(\S+)$/)
  if (other) return { kind: other[1], key: text }
  const refs = parseLawRefs(text)
  if (refs.length) return refs[0]
  const law = LAW_BY_TOKEN.get(text) ?? LAW_BY_TOKEN.get(text.toLowerCase().replace(/(?:ens|en)$/, ''))
  if (law) return { kind: 'sfs', sfs: law.sfs, chapter: null, section: null, stycke: null, punkt: null, key: `sfs:${law.sfs}`, law: law.title }
  return null
}

/** The title of an SFS number we know, or "SFS <number>". */
export function lawTitle(sfs) {
  return LAWS.find((l) => l.sfs === sfs)?.title ?? `SFS ${sfs}`
}

/** True when a reference falls under a query: the same law, and every level the query names. */
export function refMatches(ref, query) {
  if (ref.kind !== query.kind) return false
  if (query.kind !== 'sfs') return ref.key === query.key || ref.key.startsWith(`${query.key}#`)
  if (ref.sfs !== query.sfs) return false
  for (const level of ['chapter', 'section', 'stycke', 'punkt']) {
    if (query[level] != null && String(ref[level]) !== String(query[level])) return false
  }
  return true
}
