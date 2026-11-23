/**
 * The kinds of movement in the specification of changes in equity (K3 6.3
 * a-e), as stable keys with their printed labels. A module of its own so the
 * request schemas can name the kinds without loading the specification
 * builder (and the ledger reads behind it).
 */
/**
 * Movement kinds, stable keys (P3 maps them to taxonomy concepts). The group
 * is the K3 6.3 letter the kind answers.
 */
export type EquityMovementKind =
  | 'arets_resultat'
  | 'rattelse_av_fel'
  | 'andrad_redovisningsprincip'
  | 'uppskrivning'
  | 'verkligt_varde'
  | 'ovriga_direkt_mot_eget_kapital'
  | 'utdelning'
  | 'aktieagartillskott'
  | 'aterbetalt_tillskott'
  | 'nyemission'
  | 'insatser_inbetalda'
  | 'insatser_aterbetalda'
  | 'andra_vardeoverforingar'
  | 'resultatdisposition'
  | 'fondemission'
  | 'omforing'
  | 'ovrigt'

export interface EquityMovementKindInfo {
  kind: EquityMovementKind
  /** The row label in the årsredovisning (Swedish, statutory document text). */
  label: string
  /** K3 6.3: a = result, b = retroactive/error, c = direct to equity, d = owners, e = omföringar. */
  group: 'a' | 'b' | 'c' | 'd' | 'e' | 'unclassified'
}

/** Kinds in presentation order (K3 6.3 a-e). */
export const EQUITY_MOVEMENT_KINDS: readonly EquityMovementKindInfo[] = [
  { kind: 'rattelse_av_fel', label: 'Effekt av rättelse av fel', group: 'b' },
  { kind: 'andrad_redovisningsprincip', label: 'Effekt av ändrad redovisningsprincip', group: 'b' },
  { kind: 'resultatdisposition', label: 'Disposition enligt stämmans beslut', group: 'e' },
  { kind: 'utdelning', label: 'Utdelning', group: 'd' },
  { kind: 'aktieagartillskott', label: 'Erhållna tillskott', group: 'd' },
  { kind: 'aterbetalt_tillskott', label: 'Återbetalda tillskott', group: 'd' },
  { kind: 'nyemission', label: 'Nyemission', group: 'd' },
  { kind: 'insatser_inbetalda', label: 'Inbetalda insatser', group: 'd' },
  { kind: 'insatser_aterbetalda', label: 'Återbetalda insatser', group: 'd' },
  { kind: 'andra_vardeoverforingar', label: 'Andra värdeöverföringar till ägare', group: 'd' },
  { kind: 'fondemission', label: 'Fondemission', group: 'e' },
  { kind: 'omforing', label: 'Omföring mellan poster i eget kapital', group: 'e' },
  { kind: 'uppskrivning', label: 'Uppskrivning av anläggningstillgångar', group: 'c' },
  { kind: 'verkligt_varde', label: 'Förändring av verkligt värde', group: 'c' },
  { kind: 'ovriga_direkt_mot_eget_kapital', label: 'Övriga poster redovisade direkt mot eget kapital', group: 'c' },
  { kind: 'ovrigt', label: 'Övriga förändringar', group: 'unclassified' },
  { kind: 'arets_resultat', label: 'Årets resultat', group: 'a' },
]

const KIND_INFO = new Map(EQUITY_MOVEMENT_KINDS.map((info) => [info.kind, info]))

/**
 * The row labels of a K2 årsredovisning where the K2 taxonomy names the row
 * differently (se-gen-base, "Förändringar i eget kapital"): the document
 * prints the taxonomy's own rubrik, so nothing has to be logged as a changed
 * rubrik in the iXBRL document (Bolagsverket's tillämpningsanvisning 2.20).
 * A kind the K2 taxonomy has no row for keeps the general label.
 */
const K2_LABELS: Partial<Record<EquityMovementKind, string>> = {
  resultatdisposition: 'Balanseras i ny räkning',
  utdelning: 'Vinstutdelning',
  aktieagartillskott: 'Erhållna aktieägartillskott',
  aterbetalt_tillskott: 'Återbetalning av aktieägartillskott',
  uppskrivning: 'Uppskrivning av anläggningstillgång',
}

/** The row label of a kind, as the year's regelverk prints it (K3 when not said). */
export function equityMovementLabel(kind: EquityMovementKind, framework: 'k2' | 'k3' = 'k3'): string {
  return (framework === 'k2' ? K2_LABELS[kind] : undefined) ?? KIND_INFO.get(kind)?.label ?? kind
}

/** Kinds the user may assign to a verifikat the ledger cannot classify. */
export const USER_CLASSIFIABLE_KINDS: readonly EquityMovementKind[] = [
  'rattelse_av_fel',
  'andrad_redovisningsprincip',
  'uppskrivning',
  'verkligt_varde',
  'ovriga_direkt_mot_eget_kapital',
  'utdelning',
  'aktieagartillskott',
  'aterbetalt_tillskott',
  'nyemission',
  'andra_vardeoverforingar',
  'omforing',
]
