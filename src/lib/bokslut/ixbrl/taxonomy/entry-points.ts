/**
 * Taxonomy entry points accepted by Bolagsverket's inlämningstjänst.
 *
 * An entry point fixes three things for a generated instance document:
 *   1. The schemaRefs (the årsredovisning report + the fastställelseintyg
 *      "COA" report (certificate of adoption) exactly as in the official
 *      examples; allowed ÅR/FI/RB combinations per the "kombinationer
 *      taxonomirapporter" v1.4 list).
 *   2. The xmlns prefix → namespace URI map. The 2024-09-12 K2 generation
 *      still uses the 2021-10-31 base-concept namespaces (se-gen-base,
 *      se-cd-base, se-mem-base): verified against the entry-point XSD import
 *      chain in taxonomi-paket-2024-09-12_rev20250312.zip.
 *   3. Which generated concept registry validates the emitted facts.
 *
 * Shipped: K2 AB `risbs` 2024-09-12 (full RR + full BR: matches the PDF
 * layout) and K3 AB `risbs` 2021-10-31 (the same layout under K3; its
 * registry is generated from the 2026-08-31 taxonomy package). Which entry
 * point a company files under is resolveEntryPoint's call.
 */

export type Uppstallningsform = 'risbs' | 'risab' | 'raibs' | 'raiab' | 'full'

export interface TaxonomyEntryPoint {
  id: string
  regelverk: 'K2' | 'K3'
  foretagsform: 'AB'
  uppstallningsform: Uppstallningsform
  /** Version directory of the ÅR taxonomy, e.g. "2024-09-12". */
  taxonomyVersion: string
  /** Version of the fastställelseintyg (COA) taxonomy. */
  faststallelseintygVersion: string
  /** link:schemaRef hrefs, in document order. */
  schemaRefs: string[]
  /** xmlns declarations for the <html> root, prefix → URI. */
  namespaces: Record<string, string>
  /** Registry id resolved via getRegistry(). */
  registryId: string
  /**
   * Units the generator declares beyond SEK and procent. Medelantal
   * anställda is counted in a unit each framework's examples name in their
   * own datatype namespace: K2 `se-k2-type:AntalAnstallda` (official K2
   * example 1), K3 `se-k3-type:AntalPersoner` (official K3 example 3, 2021).
   */
  units: {
    antalAnstallda: { id: string; measure: string }
  }
}

export const K2_AB_RISBS_2024_09_12: TaxonomyEntryPoint = {
  id: 'k2-ab-risbs-2024-09-12',
  regelverk: 'K2',
  foretagsform: 'AB',
  uppstallningsform: 'risbs',
  taxonomyVersion: '2024-09-12',
  faststallelseintygVersion: '2020-12-01',
  schemaRefs: [
    'http://xbrl.taxonomier.se/se/fr/gaap/k2-all/ab/risbs/2024-09-12/se-k2-ab-risbs-2024-09-12.xsd',
    'http://xbrl.taxonomier.se/se/fr/gaap/coa/rplc/2020-12-01/se-coa-rplc-2020-12-01.xsd',
  ],
  namespaces: {
    ix: 'http://www.xbrl.org/2013/inlineXBRL',
    xbrli: 'http://www.xbrl.org/2003/instance',
    link: 'http://www.xbrl.org/2003/linkbase',
    xlink: 'http://www.w3.org/1999/xlink',
    iso4217: 'http://www.xbrl.org/2003/iso4217',
    ixt: 'http://www.xbrl.org/inlineXBRL/transformation/2010-04-20',
    'se-gen-base': 'http://www.taxonomier.se/se/fr/gen-base/2021-10-31',
    'se-cd-base': 'http://www.taxonomier.se/se/fr/cd-base/2021-10-31',
    'se-mem-base': 'http://www.taxonomier.se/se/fr/mem-base/2021-10-31',
    'se-bol-base': 'http://www.bolagsverket.se/se/fr/comp-base/2020-12-01',
    'se-gaap-ext': 'http://www.taxonomier.se/se/fr/gaap/gaap-ext/2024-09-12',
    'se-k2-type': 'http://www.taxonomier.se/se/fr/k2/datatype',
  },
  registryId: 'k2-ab-2024-09-12',
  units: { antalAnstallda: { id: 'antal-anstallda', measure: 'se-k2-type:AntalAnstallda' } },
}

/**
 * K3 AB risbs, taxonomy 2021-10-31 (the current K3 AB version; taxonomier.se
 * revised it 2026-08-31 in place, so the schemaRef is unchanged). Namespaces
 * as in Bolagsverket's official K3 example 3 (2021): base concepts and
 * se-gaap-ext on the 2021-10-31 generation, the fastställelseintyg on
 * comp-base 2020-12-01. The entry point imports the forms fcd, fdr, fscie,
 * fisbn, fbs, fcf, fdisc and fsign; its registry holds exactly their
 * concepts (scripts/generate-taxonomy-registry.ts).
 */
export const K3_AB_RISBS_2021_10_31: TaxonomyEntryPoint = {
  id: 'k3-ab-risbs-2021-10-31',
  regelverk: 'K3',
  foretagsform: 'AB',
  uppstallningsform: 'risbs',
  taxonomyVersion: '2021-10-31',
  faststallelseintygVersion: '2020-12-01',
  schemaRefs: [
    'http://xbrl.taxonomier.se/se/fr/gaap/k3/risbs/2021-10-31/se-k3-risbs-2021-10-31.xsd',
    'http://xbrl.taxonomier.se/se/fr/gaap/coa/rplc/2020-12-01/se-coa-rplc-2020-12-01.xsd',
  ],
  namespaces: {
    ix: 'http://www.xbrl.org/2013/inlineXBRL',
    xbrli: 'http://www.xbrl.org/2003/instance',
    link: 'http://www.xbrl.org/2003/linkbase',
    xlink: 'http://www.w3.org/1999/xlink',
    iso4217: 'http://www.xbrl.org/2003/iso4217',
    ixt: 'http://www.xbrl.org/inlineXBRL/transformation/2010-04-20',
    'se-gen-base': 'http://www.taxonomier.se/se/fr/gen-base/2021-10-31',
    'se-cd-base': 'http://www.taxonomier.se/se/fr/cd-base/2021-10-31',
    'se-mem-base': 'http://www.taxonomier.se/se/fr/mem-base/2021-10-31',
    'se-bol-base': 'http://www.bolagsverket.se/se/fr/comp-base/2020-12-01',
    'se-gaap-ext': 'http://www.taxonomier.se/se/fr/gaap/gaap-ext/2021-10-31',
    'se-k3-type': 'http://www.taxonomier.se/se/fr/k3/datatype',
  },
  registryId: 'k3-ab-2021-10-31',
  units: { antalAnstallda: { id: 'antal-personer', measure: 'se-k3-type:AntalPersoner' } },
}

const ENTRY_POINTS: Record<string, TaxonomyEntryPoint> = {
  [K2_AB_RISBS_2024_09_12.id]: K2_AB_RISBS_2024_09_12,
  [K3_AB_RISBS_2021_10_31.id]: K3_AB_RISBS_2021_10_31,
}

export function getEntryPoint(id: string): TaxonomyEntryPoint {
  const ep = ENTRY_POINTS[id]
  if (!ep) {
    throw new Error(
      `Unknown taxonomy entry point "${id}": known: ${Object.keys(ENTRY_POINTS).join(', ')}`,
    )
  }
  return ep
}

/**
 * The message a K3 caller gets while the K3 iXBRL document is switched off
 * (NEXT_PUBLIC_K3_IXBRL_ENABLED): what is possible and what is not, never a
 * pointer to a paper flow that is not open for K3 either.
 */
export const K3_IXBRL_DISABLED_MESSAGE =
  'Accounted skapar ännu inget iXBRL-dokument för K3-årsredovisningar och kan inte lämna in dem digitalt. ' +
  'K3-dokumentet finns som PDF för granskning; inlämningen öppnas när K3-dokumentet har granskats och godkänts.'

/**
 * Resolve the entry point for a company's filing. K2 resolves to K2 AB
 * risbs; K3 to K3 AB risbs when the K3 iXBRL document is switched on, and
 * otherwise a descriptive error the UI can surface instead of a document.
 */
export function resolveEntryPoint(
  framework: 'k2' | 'k3',
  options: { k3Enabled: boolean } = { k3Enabled: false },
): TaxonomyEntryPoint {
  if (framework === 'k2') return K2_AB_RISBS_2024_09_12
  if (options.k3Enabled) return K3_AB_RISBS_2021_10_31
  throw new Error(K3_IXBRL_DISABLED_MESSAGE)
}
