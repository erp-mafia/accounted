import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { formatOrgNumber } from '@/lib/utils'
import { formatDateSv, pdfNumberText } from '@/lib/pdf/number-text'
import { ink3Sections, ink3SignMark } from './presentation'
import type { Ink3Field, Ink3Underlag } from './types'

/**
 * The INK3 underlag as a PDF: what to type into Skatteverket's e-tjänst
 * Inkomstdeklaration 2, 3 och 4, ruta by ruta, with the field codes. It is a
 * reading and record copy, never a filing: the first page is signed in the
 * e-tjänst, and the note on the first page says so.
 *
 * Swedish only: the rutor and their labels are Skatteverket's form labels.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 40, paddingBottom: 70, fontSize: 9, fontFamily: 'Helvetica' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#333', marginBottom: 2 },
  meta: { fontSize: 9, color: '#666' },
  companyBlock: { textAlign: 'right' },
  companyName: { fontSize: 10, fontWeight: 'bold', marginBottom: 2 },
  note: {
    marginBottom: 14,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 0.8,
    borderColor: '#b45309',
    backgroundColor: '#fef3c7',
    borderRadius: 3,
  },
  noteText: { fontSize: 8, color: '#78350f', lineHeight: 1.35 },
  section: { fontSize: 10, fontWeight: 'bold', marginTop: 12, marginBottom: 4 },
  headRow: { flexDirection: 'row', paddingBottom: 3, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  head: { fontSize: 7.5, fontWeight: 'bold', color: '#444' },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.4, borderBottomColor: '#e5e5e5' },
  colRuta: { width: 34, fontFamily: 'Courier', color: '#666' },
  colLabel: { flex: 1, paddingRight: 8 },
  colCode: { width: 34, fontFamily: 'Courier', color: '#666', textAlign: 'right' },
  colAmount: { width: 72, fontFamily: 'Courier', textAlign: 'right' },
  waiting: { color: '#b45309' },
  warning: { fontSize: 8, color: '#78350f', marginBottom: 2 },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 7.5, color: '#888' },
})

function kr(amount: number): string {
  return pdfNumberText(new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(amount))
}

/** The printed value of a field: kronor, an X for a ticked box, text, or blank. */
function shown(field: Ink3Field | null): string {
  if (!field || field.value === null || field.value === false) return ''
  if (field.value === true) return 'X'
  if (typeof field.value === 'string') return field.value
  if (field.datatyp === 'Numeriskt_N') return `${field.value} %`
  return field.value === 0 ? '' : kr(field.value)
}

function waitingMark(field: Ink3Field | null): string {
  return field?.needsInput ? ' *' : ''
}

function FieldRow({ field }: { field: Ink3Field }) {
  return (
    <View style={styles.row} wrap={false}>
      <Text style={styles.colRuta}>{field.ruta ?? ''}</Text>
      <Text style={styles.colLabel}>
        {ink3SignMark(field) ? `${ink3SignMark(field)} ` : ''}
        {field.label}
      </Text>
      <Text style={styles.colCode}>{field.code}</Text>
      <Text style={[styles.colAmount, ...(field.needsInput ? [styles.waiting] : [])]}>
        {shown(field)}
        {waitingMark(field)}
      </Text>
    </View>
  )
}

function FieldTable({ title, fields }: { title: string; fields: Ink3Field[] }) {
  if (fields.length === 0) return null
  return (
    <View>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.headRow} fixed>
        <Text style={[styles.head, styles.colRuta]}>Ruta</Text>
        <Text style={[styles.head, styles.colLabel]}>Beskrivning</Text>
        <Text style={[styles.head, styles.colCode]}>Fältkod</Text>
        <Text style={[styles.head, styles.colAmount]}>Belopp (kr)</Text>
      </View>
      {fields.map((field) => (
        <FieldRow key={field.code} field={field} />
      ))}
    </View>
  )
}

export function Ink3UnderlagPDF({ underlag, generatedAt }: { underlag: Ink3Underlag; generatedAt: string }) {
  const sections = ink3Sections(underlag.fields)
  const { companyInfo, fiscalYear } = underlag
  const waiting = underlag.fields.filter((f) => f.needsInput).length
  const allmannyttig =
    underlag.allmannyttig === null ? 'inte angivet' : underlag.allmannyttig ? 'ja' : 'nej'

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>Inkomstdeklaration 3, underlag</Text>
            <Text style={styles.subtitle}>
              Räkenskapsår {formatDateSv(fiscalYear.start)} till {formatDateSv(fiscalYear.end)}
            </Text>
            <Text style={styles.meta}>
              Beskattningsperiod {underlag.beskattningsperiod} · Fältkoder enligt {underlag.fieldTable.files.join(', ')}
            </Text>
          </View>
          <View style={styles.companyBlock}>
            <Text style={styles.companyName}>{companyInfo.companyName}</Text>
            {companyInfo.orgNumber && (
              <Text style={styles.meta}>Org.nr: {formatOrgNumber(companyInfo.orgNumber)}</Text>
            )}
          </View>
        </View>

        <View style={styles.note}>
          <Text style={styles.noteText}>
            Underlag för Skatteverkets e-tjänst Inkomstdeklaration 2, 3 och 4. Detta är inte en inlämnad
            deklaration: skriv in beloppen i e-tjänsten och skriv under deklarationens första sida där.
            Belopp i hela kronor. Allmännyttig enligt föreningens egen bedömning: {allmannyttig}.
            {waiting > 0 ? ` ${waiting} rutor markerade med * väntar på föreningens bedömning.` : ''}
          </Text>
        </View>

        <FieldTable title="INK3R Räkenskapsschema: Tillgångar" fields={sections.assets} />
        <FieldTable title="INK3R Räkenskapsschema: Eget kapital, avsättningar och skulder" fields={sections.equityLiabilities} />

        <View>
          <Text style={styles.section}>INK3R Räkenskapsschema: Resultaträkning</Text>
          <View style={styles.headRow} fixed>
            <Text style={[styles.head, styles.colRuta]}>Ruta</Text>
            <Text style={[styles.head, styles.colLabel]}>Beskrivning</Text>
            <Text style={[styles.head, styles.colCode]}>Fältkod</Text>
            <Text style={[styles.head, styles.colAmount]}>Enligt redovisningen</Text>
            <Text style={[styles.head, styles.colCode]}>Fältkod</Text>
            <Text style={[styles.head, styles.colAmount]}>Som ska tas upp/dras av</Text>
          </View>
          {sections.incomeStatement.map((row) => (
            <View key={row.key} style={styles.row} wrap={false}>
              <Text style={styles.colRuta}>{row.ruta}</Text>
              <Text style={styles.colLabel}>
                {row.sign} {row.label}
              </Text>
              <Text style={styles.colCode}>{row.bokforing?.code ?? ''}</Text>
              <Text style={styles.colAmount}>
                {shown(row.bokforing)}
                {waitingMark(row.bokforing)}
              </Text>
              <Text style={styles.colCode}>{row.skattepliktig?.code ?? ''}</Text>
              <Text style={[styles.colAmount, ...(row.skattepliktig?.needsInput ? [styles.waiting] : [])]}>
                {shown(row.skattepliktig)}
                {waitingMark(row.skattepliktig)}
              </Text>
            </View>
          ))}
          {sections.results.map((field) => (
            <FieldRow key={field.code} field={field} />
          ))}
        </View>

        <FieldTable title="INK3S Skattemässiga justeringar" fields={sections.ink3s} />

        {underlag.sufApplicable && (
          <View>
            <FieldTable title="INK3SUF Särskild uppgift: ändamål" fields={sections.sufPurposes} />
            <FieldTable title="INK3SUF Särskild uppgift: fastighet" fields={sections.sufProperty} />
            <FieldTable title="INK3SUF Särskild uppgift: skattefri verksamhet" fields={sections.sufAmounts} />
          </View>
        )}

        {underlag.warnings.length > 0 && (
          <View>
            <Text style={styles.section}>Att kontrollera</Text>
            {underlag.warnings.map((warning, i) => (
              <Text key={i} style={styles.warning}>
                {warning}
              </Text>
            ))}
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {companyInfo.companyName}
            {companyInfo.orgNumber ? ` · ${formatOrgNumber(companyInfo.orgNumber)}` : ''}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Genererad ${formatDateSv(generatedAt)} · Sida ${pageNumber} av ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  )
}
