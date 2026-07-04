/**
 * Taxonomy entry points accepted by Bolagsverket's inlämningstjänst.
 *
 * An entry point fixes three things for a generated instance document:
 *   1. The schemaRefs (the årsredovisning report + the fastställelseintyg
 *      "COA" report (certificate of adoption) exactly as in the official
 *      examples; allowed ÅR/FI/RB combinations per
 *      dev_docs/bokslut/kombinationer-taxonomirapporter-v1.4-screenshot.png).
 *   2. The xmlns prefix → namespace URI map. The 2024-09-12 K2 generation
 *      still uses the 2021-10-31 base-concept namespaces (se-gen-base,
 *      se-cd-base, se-mem-base): verified against the entry-point XSD import
 *      chain in taxonomi-paket-2024-09-12_rev20250312.zip.
 *   3. Which generated concept registry validates the emitted facts.
 *
 * MVP ships K2 AB `risbs` (full RR + full BR: matches the current PDF
 * layout). The other K2 forms and K3 land in M6.
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
}

const ENTRY_POINTS: Record<string, TaxonomyEntryPoint> = {
  [K2_AB_RISBS_2024_09_12.id]: K2_AB_RISBS_2024_09_12,
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
 * Resolve the entry point for a company's filing. Today only K2 AB risbs is
 * supported; K3 callers get a descriptive error the UI can surface instead of
 * a generated-but-rejectable document.
 */
export function resolveEntryPoint(framework: 'k2' | 'k3'): TaxonomyEntryPoint {
  if (framework === 'k2') return K2_AB_RISBS_2024_09_12
  throw new Error(
    'Digital inlämning stöds ännu inte för K3: generera PDF eller vänta på K3-stödet (M6).',
  )
}
