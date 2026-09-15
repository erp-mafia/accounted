/**
 * PDF blocks shared by the K2 and K3 årsredovisning templates for a
 * bostadsrättsförening:
 *   - the förvaltningsberättelse additions of ÅRL 6 kap. 3 a § and BFNAR
 *     2012:1 kapitel 38 (the 38.2 statements, the nyckeltal table for the
 *     year and three prior years per 38.4, the loss disclosure), and
 *   - the kassaflödesanalys page, which ÅRL 2 kap. 1 § andra stycket
 *     requires of every bostadsrättsförening whatever its size, so the K2
 *     template renders it for the form too (the K3 template always did).
 *
 * Both templates keep their own StyleSheet; the blocks take the handful of
 * styles they use as props so the aktiebolag output of each template stays
 * byte-identical.
 */
import { Page, Text, View } from '@react-pdf/renderer'
import type { Style } from '@react-pdf/types'
import type { ArsredovisningData, BrfDisclosures } from './types'
import type { BrfNyckeltalRow } from './brf-nyckeltal'

export interface BrfSectionStyles {
  page: Style
  sectionTitle: Style
  paragraph: Style
  tableHeader: Style
  tableRow: Style
  tableRowSubtotal: Style
  tableRowTotal: Style
  colLabel: Style
  colAmount: Style
  reconciliationBlock: Style
}

type Fmt = (amount: number) => string

const dash = '-'

function kr(value: number | null, fmt: Fmt): string {
  return value === null ? dash : fmt(value)
}

function pct(value: number | null): string {
  return value === null ? dash : `${value.toFixed(1).replace('.', ',')} %`
}

interface NyckeltalLine {
  label: string
  pick: (row: BrfNyckeltalRow) => string
}

function nyckeltalLines(fmt: Fmt): NyckeltalLine[] {
  return [
    { label: 'Nettoomsättning (kr)', pick: (r) => fmt(r.nettoomsattning) },
    { label: 'Resultat efter finansiella poster (kr)', pick: (r) => fmt(r.resultat_efter_finansiella_poster) },
    { label: 'Soliditet', pick: (r) => pct(r.soliditet_pct) },
    { label: 'Årsavgift per kvm upplåten med bostadsrätt (kr/kvm)', pick: (r) => kr(r.arsavgift_per_kvm_bostadsratt, fmt) },
    { label: '  varav bostäder (kr/kvm)', pick: (r) => kr(r.arsavgift_per_kvm_bostader, fmt) },
    { label: '  varav lokaler (kr/kvm)', pick: (r) => kr(r.arsavgift_per_kvm_lokaler, fmt) },
    { label: 'Skuldsättning per kvm (kr/kvm)', pick: (r) => kr(r.skuldsattning_per_kvm, fmt) },
    { label: 'Skuldsättning per kvm upplåten med bostadsrätt (kr/kvm)', pick: (r) => kr(r.skuldsattning_per_kvm_bostadsratt, fmt) },
    { label: 'Sparande per kvm (kr/kvm)', pick: (r) => kr(r.sparande_per_kvm, fmt) },
    { label: 'Räntekänslighet', pick: (r) => pct(r.rantekanslighet_pct) },
    { label: 'Energikostnad per kvm (kr/kvm)', pick: (r) => kr(r.energikostnad_per_kvm, fmt) },
    { label: 'Årsavgifternas andel av totala intäkter', pick: (r) => pct(r.arsavgifternas_andel_pct) },
  ]
}

/**
 * Rendered inside förvaltningsberättelsen after the flerårsöversikt. The
 * caller decides whether the year is a loss (K3 38 kommentar to ÅRL 6 kap.
 * 3 a § andra stycket) from the statement mapping, not from the nyckeltal.
 */
export function BrfForvaltningsberattelseSection({
  brf,
  styles,
  fmt,
  resultIsLoss,
}: {
  brf: BrfDisclosures
  styles: Pick<BrfSectionStyles, 'sectionTitle' | 'paragraph' | 'tableHeader' | 'tableRow' | 'colLabel' | 'colAmount'>
  fmt: Fmt
  resultIsLoss: boolean
}) {
  const years = brf.nyckeltal
  const current = years.at(-1) ?? null
  const lokalerComment =
    current && current.arsavgift_per_kvm_lokaler === null && current.underlag.arsavgifter_lokaler === 0
      ? 'Föreningen upplåter inga lokaler med bostadsrätt.'
      : null
  const hyresrattComment =
    current && current.underlag.kvm_upplaten_total !== null && current.underlag.kvm_bostadsratt !== null &&
    current.underlag.kvm_upplaten_total === current.underlag.kvm_bostadsratt
      ? 'Föreningen upplåter endast ytor med bostadsrätt.'
      : null
  return (
    <>
      <Text style={styles.sectionTitle}>Viktiga förhållanden (BFNAR 2012:1 punkt 38.2)</Text>
      <Text style={styles.paragraph}>
        Föreningen{' '}
        {brf.privatbostadsforetag === null
          ? 'har inte bedömt om den är ett privatbostadsföretag'
          : brf.privatbostadsforetag
            ? 'är ett privatbostadsföretag (äkta bostadsrättsförening)'
            : 'är inte ett privatbostadsföretag (oäkta bostadsrättsförening)'}{' '}
        enligt inkomstskattelagen (1999:1229).
      </Text>
      <Text style={styles.paragraph}>
        {brf.tomtratt === null
          ? 'Uppgift om föreningen innehar marken med tomträtt eller äganderätt saknas.'
          : brf.tomtratt
            ? `Föreningen innehar marken med tomträtt${brf.tomtratt_expires_on ? ` som gäller till ${brf.tomtratt_expires_on}` : ''}.${
                brf.tomtratt_avgald_until
                  ? ` Avgäldsperioden går ut ${brf.tomtratt_avgald_until}, då avgälden ska omförhandlas.`
                  : ' Uppgift om när avgäldsperioden går ut saknas.'
              }`
            : 'Föreningen innehar marken med äganderätt.'}
      </Text>
      <Text style={styles.paragraph}>
        {brf.samfallighet?.trim()
          ? `Föreningens fastighet har del i samfällighet: ${brf.samfallighet.trim()}`
          : 'Föreningens fastighet har inte del i någon samfällighet.'}
      </Text>
      <Text style={styles.paragraph}>
        {brf.underhallsplan === null
          ? 'Uppgift om föreningen har en aktuell underhållsplan saknas.'
          : brf.underhallsplan
            ? 'Föreningen har en aktuell underhållsplan.'
            : 'Föreningen har inte någon aktuell underhållsplan.'}
      </Text>

      <Text style={styles.sectionTitle}>Nyckeltal (ÅRL 6 kap. 3 a §, BFNAR 2012:1 punkt 38.3-38.9)</Text>
      <View style={styles.tableHeader}>
        <Text style={styles.colLabel}>Nyckeltal</Text>
        {years.map((row) => (
          <Text key={row.year} style={styles.colAmount}>
            {row.year}
          </Text>
        ))}
      </View>
      {nyckeltalLines(fmt).map((line) => (
        <View key={line.label} style={styles.tableRow}>
          <Text style={styles.colLabel}>{line.label}</Text>
          {years.map((row) => (
            <Text key={row.year} style={styles.colAmount}>
              {line.pick(row)}
            </Text>
          ))}
        </View>
      ))}
      {lokalerComment && <Text style={styles.paragraph}>{lokalerComment}</Text>}
      {hyresrattComment && <Text style={styles.paragraph}>{hyresrattComment}</Text>}
      {brf.energikostnad_vidaredebiterad !== null && brf.energikostnad_vidaredebiterad > 0 && (
        <Text style={styles.paragraph}>
          Av energikostnaden har {fmt(brf.energikostnad_vidaredebiterad)} kr vidaredebiterats medlemmarna efter
          individuell mätning.
        </Text>
      )}
      <Text style={styles.paragraph}>
        Definitioner: årsavgift per kvm = årsavgifter inklusive avgifter efter förbrukning / yta upplåten med bostadsrätt;
        skuldsättning per kvm = räntebärande skulder till kreditinstitut / yta upplåten med bostadsrätt och hyresrätt;
        sparande per kvm = (årets resultat + avskrivningar + utrangeringar + kostnadsfört planerat underhåll, justerat för
        väsentliga poster utanför den normala verksamheten) / yta upplåten med bostadsrätt och hyresrätt; räntekänslighet
        = 1 % av räntebärande skulder / årsavgifter; energikostnad per kvm = kostnad för uppvärmning, el och vatten / yta
        upplåten med bostadsrätt och hyresrätt; soliditet = eget kapital / balansomslutning. Ytor enligt föreningens
        nuvarande uppgifter, tillämpade på samtliga år.
      </Text>
      {brf.facts_missing.length > 0 && (
        <Text style={styles.paragraph}>
          Nyckeltal som saknar underlag visas med streck (uppgift saknas: {brf.facts_missing.join(', ')}).
        </Text>
      )}

      {resultIsLoss && (
        <>
          <Text style={styles.sectionTitle}>Upplysning om förlust (ÅRL 6 kap. 3 a § andra stycket)</Text>
          <Text style={styles.paragraph}>
            {brf.loss_financing_explanation?.trim() ||
              'Uppgift om vad förlusten innebär för föreningens möjlighet att finansiera sina framtida ekonomiska åtaganden saknas.'}
          </Text>
        </>
      )}
    </>
  )
}

/** The kassaflödesanalys page, indirect method (BFNAR 2012:1 kapitel 7). */
export function KassaflodesanalysPage({
  data,
  styles,
  fmt,
  chrome,
}: {
  data: ArsredovisningData
  styles: BrfSectionStyles
  fmt: Fmt
  chrome: React.ReactNode
}) {
  const k = data.kassaflodesanalys
  if (!k) return null
  const row = (label: string, amount: number, style: Style = styles.tableRow) => (
    <View style={style}>
      <Text style={styles.colLabel}>{label}</Text>
      <Text style={styles.colAmount}>{fmt(amount)}</Text>
    </View>
  )
  return (
    <Page size="A4" style={styles.page}>
      {chrome}
      <Text style={styles.sectionTitle}>Kassaflödesanalys (kr)</Text>
      <Text style={[styles.paragraph, { fontSize: 9, color: '#666' }]}>Indirekt metod enligt BFNAR 2012:1 kap 7.</Text>

      <Text style={styles.sectionTitle}>Den löpande verksamheten</Text>
      {row('Resultat efter finansiella poster', k.lopande.resultat_efter_finansiella_poster)}
      {row('Justeringar för avskrivningar', k.lopande.avskrivningar)}
      {row('Övriga ej-kassaflödespåverkande poster', k.lopande.ovriga_ej_kassaflodesposter)}
      {row('Förändring av kortfristiga fordringar', k.lopande.delta_kortfristiga_fordringar)}
      {row('Förändring av varulager', k.lopande.delta_varulager)}
      {row('Förändring av kortfristiga skulder', k.lopande.delta_kortfristiga_skulder)}
      {row('Betald inkomstskatt', k.lopande.skatt_betald)}
      {row('Kassaflöde från den löpande verksamheten', k.lopande.total, styles.tableRowSubtotal)}

      <Text style={styles.sectionTitle}>Investeringsverksamheten</Text>
      {row('Förvärv av anläggningstillgångar', k.investerings.forvarv_anlaggningar)}
      {row('Avyttring av anläggningstillgångar', k.investerings.avyttring_anlaggningar)}
      {row('Kassaflöde från investeringsverksamheten', k.investerings.total, styles.tableRowSubtotal)}

      <Text style={styles.sectionTitle}>Finansieringsverksamheten</Text>
      {row('Förändring av lån (långfristiga skulder)', k.finansierings.delta_lan)}
      {row('Utdelningar till medlemmar', k.finansierings.utdelningar)}
      {row('Inbetalda insatser och upplåtelseavgifter', k.finansierings.nyemission)}
      {row('Erhållna tillskott', k.finansierings.erhallna_aktieagartillskott)}
      {row('Kassaflöde från finansieringsverksamheten', k.finansierings.total, styles.tableRowSubtotal)}

      {row('Årets kassaflöde', k.total_cash_flow, styles.tableRowTotal)}

      <View style={styles.reconciliationBlock}>
        <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>Avstämning mot likvida medel (19xx)</Text>
        {row('Ingående saldo', k.reconciliation.opening_cash_1xxx)}
        {row('Utgående saldo', k.reconciliation.closing_cash_1xxx)}
        {row('Faktisk förändring', k.reconciliation.delta_actual)}
        {!k.reconciliation.is_reconciled && (
          <View style={styles.tableRow}>
            <Text style={[styles.colLabel, { color: '#b91c1c' }]}>Avvikelse: kontrollera bokföringen</Text>
            <Text style={[styles.colAmount, { color: '#b91c1c' }]}>{fmt(k.reconciliation.mismatch_amount)}</Text>
          </View>
        )}
      </View>
    </Page>
  )
}
