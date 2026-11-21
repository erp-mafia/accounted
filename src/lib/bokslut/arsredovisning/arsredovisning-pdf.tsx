import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { ArsredovisningData, StatementRow } from './types'
import { formatPdfKronor } from './pdf-format'
import { pdfTextDeep } from '@/lib/pdf/number-text'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { EquitySpecificationTable } from './equity-specification-pdf'
import {
  type ArsredovisningPdfMode,
  CERTIFICATE_SIGNER,
  CERTIFICATE_SIGNER_LINE,
  draftCertificateNote,
  eSigningCertificateNote,
  PAPER_COPY_CERTIFICATION,
} from './signature-pages'
import { SignaturesPdf } from './signatures-pdf'

const styles = StyleSheet.create({
  page: {
    paddingTop: 50,
    paddingHorizontal: 50,
    paddingBottom: 60,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  pageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    fontSize: 8,
    color: '#555',
    borderBottomWidth: 0.5,
    borderBottomColor: '#aaa',
    paddingBottom: 6,
  },
  pageFooter: {
    position: 'absolute',
    bottom: 30,
    left: 50,
    right: 50,
    fontSize: 8,
    color: '#888',
    textAlign: 'center',
  },
  title: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    marginTop: 40,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 12,
    color: '#444',
    marginBottom: 50,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    marginTop: 20,
    marginBottom: 10,
  },
  paragraph: {
    marginBottom: 8,
    lineHeight: 1.4,
  },
  noteBody: {
    marginBottom: 4,
    lineHeight: 1.4,
  },
  tableHeader: {
    flexDirection: 'row',
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  tableRowTotal: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderTopWidth: 0.5,
    borderTopColor: '#888',
    fontFamily: 'Helvetica-Bold',
  },
  colLabel: {
    flex: 1,
  },
  colLabelIndent: {
    flex: 1,
    paddingLeft: 12,
  },
  colAmount: {
    width: 100,
    textAlign: 'right',
  },
  signatureLine: {
    flexDirection: 'row',
    marginTop: 30,
    alignItems: 'flex-end',
  },
  signatureSlot: {
    flex: 1,
    marginRight: 20,
    borderBottomWidth: 0.5,
    borderBottomColor: '#333',
    paddingBottom: 2,
  },
  signatureRole: {
    width: 120,
  },
  signatureDate: {
    width: 120,
  },
  // Explains, in a draft, what a page will hold once it can be filled in.
  draftNote: {
    fontSize: 9,
    color: '#666',
    lineHeight: 1.4,
    marginBottom: 12,
  },
  draftSigner: {
    flexDirection: 'row',
    paddingVertical: 3,
  },
})

function fmt(amount: number): string {
  // sv-SE thousands grouping, no decimals: typical for K2 ÅR.
  // ASCII hyphen for negatives: Helvetica/WinAnsi has no U+2212 glyph.
  return formatPdfKronor(amount)
}

/**
 * An ÅRL 6 kap. 3 § amount: an entered 0 is the statutory "inga", an
 * unanswered one (null) prints `unanswered` so the document never states a
 * fact the user did not give.
 */
function memberAmount(amount: number | null | undefined, unanswered: string): string {
  if (amount == null) return unanswered
  return amount === 0 ? 'inga' : `${fmt(amount)} kr`
}

/**
 * Renders ÅRL post-level statement rows (see statement-rows.ts) with a
 * jämförelseår column. Headings carry no amounts; totals get the bordered
 * bold style. The previous-year column stays empty for the company's first
 * fiscal year.
 */
function StatementTable({
  rows,
  hasPrevious,
}: {
  rows: StatementRow[]
  hasPrevious: boolean
}) {
  return (
    <>
      {rows.map((line, i) => {
        const indentPad = (line.indent ?? 0) * 12
        if (line.is_heading) {
          return (
            <View key={i} style={styles.tableRow}>
              <Text
                style={{
                  flex: 1,
                  fontFamily: 'Helvetica-Bold',
                  paddingLeft: indentPad,
                  marginTop: 6,
                }}
              >
                {line.label}
              </Text>
            </View>
          )
        }
        return (
          <View key={i} style={line.is_total ? styles.tableRowTotal : styles.tableRow}>
            <Text style={{ flex: 1, paddingLeft: indentPad }}>{line.label}</Text>
            <Text style={styles.colAmount}>{fmt(line.current ?? 0)}</Text>
            <Text style={styles.colAmount}>{hasPrevious ? fmt(line.previous ?? 0) : ''}</Text>
          </View>
        )
      })}
    </>
  )
}

function PageChrome({
  data,
  pageLabel,
  mode,
}: {
  data: ArsredovisningData
  pageLabel?: string
  mode: ArsredovisningPdfMode
}) {
  return (
    <>
      <View style={styles.pageHeader} fixed>
        <Text>
          {data.company.name} · {formatOrgNumberDisplay(data.company.org_number)}
        </Text>
        <Text>
          Årsredovisning {data.fiscal_period.name}
          {mode === 'draft' ? ' (utkast)' : ''}
        </Text>
      </View>
      <Text style={styles.pageFooter} fixed>
        {pageLabel ?? ''}
      </Text>
    </>
  )
}

/**
 * @param mode 'signing' for a version locked for signature (blank lines to
 *   fill in by hand), 'draft' otherwise: see signature-pages.ts.
 */
export function ArsredovisningPDF({
  data: reportData,
  mode = 'draft',
}: {
  data: ArsredovisningData
  mode?: ArsredovisningPdfMode
}) {
  // Every text below prints in Helvetica, which has no U+2212 glyph: the
  // typed texts (förvaltningsberättelse, resultatdisposition, notes) are
  // made safe here, once, like the amounts are in fmt (crm#1887).
  const data = pdfTextDeep(reportData)
  // An ekonomisk förening adopts the statements at its ordinarie
  // föreningsstämma (EFL 6 kap. 9-10 §§), owns no share capital and must add
  // the ÅRL 6 kap. 3 § member disclosures to förvaltningsberättelsen.
  const isForening = data.company.entity_type === 'ekonomisk_forening'
  const meeting = isForening ? 'föreningsstämman' : 'årsstämman'
  const meetingNoun = isForening ? 'föreningsstämma' : 'årsstämma'
  const entityNoun = isForening ? 'föreningens' : 'bolagets'
  const member = data.forvaltningsberattelse.member_disclosures
  const hasForlagsinsatser =
    (data.balansrakning.equity_liabilities.find((row) => row.semantic_key === 'balance_sheet_forlagsinsatser')
      ?.current ?? 0) !== 0
  const agmDispositionDecision =
    data.forvaltningsberattelse.agm_disposition_outcome === 'proposal_approved'
      ? `${isForening ? 'Föreningsstämman' : 'Årsstämman'} beslutade att godkänna styrelsens förslag: ${data.forvaltningsberattelse.resultatdisposition}`
      : data.forvaltningsberattelse.agm_disposition_outcome === 'alternative_decision'
        ? data.forvaltningsberattelse.agm_disposition_decision
        : null
  return (
    <Document>
      {/* Cover */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} mode={mode} pageLabel="Försättssida" />
        <View>
          <Text style={styles.title}>Årsredovisning</Text>
          <Text style={styles.subtitle}>
            för räkenskapsåret {data.fiscal_period.period_start} till {data.fiscal_period.period_end}
          </Text>
          <Text style={styles.paragraph}>{data.company.name}</Text>
          <Text style={styles.paragraph}>Organisationsnummer: {formatOrgNumberDisplay(data.company.org_number)}</Text>
          {data.company.registered_office && (
            <Text style={styles.paragraph}>Säte: {data.company.registered_office}</Text>
          )}
        </View>
      </Page>

      {/* Förvaltningsberättelse */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} mode={mode} pageLabel="Förvaltningsberättelse" />
        <Text style={styles.sectionTitle}>Förvaltningsberättelse</Text>

        <Text style={styles.sectionTitle}>Verksamhet</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.description}</Text>

        <Text style={styles.sectionTitle}>Väsentliga händelser under räkenskapsåret</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.important_events}</Text>

        {data.forvaltningsberattelse.kontrollbalans_required && (
          <>
            <Text style={styles.sectionTitle}>Kontrollbalansräkning</Text>
            <Text style={styles.paragraph}>
              Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.
            </Text>
          </>
        )}

        <Text style={styles.sectionTitle}>Flerårsöversikt (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>År</Text>
          <Text style={styles.colAmount}>Nettoomsättning</Text>
          <Text style={styles.colAmount}>Resultat e.fin.poster</Text>
          <Text style={styles.colAmount}>Soliditet (%)</Text>
        </View>
        {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
          <View key={row.year} style={styles.tableRow}>
            <Text style={styles.colLabel}>{row.year}</Text>
            <Text style={styles.colAmount}>{fmt(row.net_revenue)}</Text>
            <Text style={styles.colAmount}>{fmt(row.result_after_financial)}</Text>
            <Text style={styles.colAmount}>
              {row.soliditet_pct === null ? '-' : row.soliditet_pct.toFixed(1)}
            </Text>
          </View>
        ))}

        {isForening && member && (
          <>
            <Text style={styles.sectionTitle}>Medlemmar och insatser</Text>
            <Text style={styles.paragraph}>
              Väsentliga förändringar i medlemsantalet: {member.member_count_change?.trim() || 'uppgift saknas'}
            </Text>
            <Text style={styles.paragraph}>
              Insatsbelopp som ska återbetalas under nästa räkenskapsår (EFL 10 kap. 11 och 16 §§):{' '}
              {memberAmount(member.insatser_repayable_next_year, 'uppgift saknas')}
            </Text>
            <Text style={styles.paragraph}>
              Rätt till utdelning som gjorda förlagsinsatser medför: {member.forlagsinsatser_dividend_right?.trim() || 'uppgift saknas'}
            </Text>
            <Text style={styles.paragraph}>
              Förlagsinsatser som har sagts upp och ska lösas in under de nästkommande två räkenskapsåren:{' '}
              {memberAmount(member.forlagsinsatser_redeemable_two_years, hasForlagsinsatser ? 'uppgift saknas' : 'inga')}
            </Text>
          </>
        )}

        <Text style={styles.sectionTitle}>Förändring av eget kapital (kr)</Text>
        {/* ÅRL 6 kap. 2 § andra stycket: the changes against last year's
            balance sheet. A version saved before the specification keeps
            its year-end list. */}
        {data.equity_specification ? (
          <EquitySpecificationTable year={data.equity_specification.current} />
        ) : (
          data.forvaltningsberattelse.egen_kapital_changes.map((r) => (
            <View key={r.label} style={styles.tableRow}>
              <Text style={styles.colLabel}>{r.label}</Text>
              <Text style={styles.colAmount}>{fmt(r.amount)}</Text>
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>Förslag till resultatdisposition</Text>
        <Text style={styles.paragraph}>{data.forvaltningsberattelse.resultatdisposition}</Text>
        {(
          [
            { label: 'Balanserat resultat', amount: data.forvaltningsberattelse.resultatdisposition_amounts.retained_earnings, isTotal: false },
            // Fri överkursfond is an aktiebolag post (ÅRL 5 kap. 14 §); a
            // förening has no överkurs and the row is omitted, so the total
            // rows are flagged explicitly rather than found by position.
            ...(isForening
              ? []
              : [{ label: 'Fri överkursfond', amount: data.forvaltningsberattelse.resultatdisposition_amounts.share_premium_reserve, isTotal: false }]),
            { label: 'Årets resultat', amount: data.forvaltningsberattelse.resultatdisposition_amounts.current_year_result, isTotal: false },
            { label: `Summa till ${meeting}s förfogande`, amount: data.forvaltningsberattelse.resultatdisposition_amounts.total, isTotal: true },
            { label: isForening ? 'Föreslagen vinstutdelning' : 'Föreslagen utdelning', amount: -data.forvaltningsberattelse.resultatdisposition_amounts.proposed_dividend, isTotal: false },
            { label: 'Balanseras i ny räkning', amount: data.forvaltningsberattelse.resultatdisposition_amounts.carried_forward, isTotal: true },
          ] as const
        ).map(({ label, amount, isTotal }) => (
          <View
            key={label}
            style={isTotal ? styles.tableRowTotal : styles.tableRow}
          >
            <Text style={styles.colLabel}>{label}</Text>
            <Text style={styles.colAmount}>{fmt(amount)}</Text>
          </View>
        ))}
      </Page>

      {/* Resultaträkning - ÅRL post level, no account numbers. */}
      <Page size="A4" style={styles.page} wrap>
        <PageChrome data={data} mode={mode} pageLabel="Resultaträkning" />
        <Text style={styles.sectionTitle}>Resultaträkning (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{data.fiscal_period.name}</Text>
          <Text style={styles.colAmount}>{data.previous_period?.name ?? ''}</Text>
        </View>
        <StatementTable rows={data.resultatrakning} hasPrevious={data.previous_period !== null} />
      </Page>

      {/* Balansräkning - ÅRL post level, no account numbers. */}
      <Page size="A4" style={styles.page} wrap>
        <PageChrome data={data} mode={mode} pageLabel="Balansräkning" />
        <Text style={styles.sectionTitle}>Tillgångar (kr)</Text>
        <View style={styles.tableHeader}>
          <Text style={styles.colLabel}>Post</Text>
          <Text style={styles.colAmount}>{data.fiscal_period.period_end}</Text>
          <Text style={styles.colAmount}>{data.previous_period?.period_end ?? ''}</Text>
        </View>
        <StatementTable
          rows={data.balansrakning.assets}
          hasPrevious={data.previous_period !== null}
        />

        <Text style={styles.sectionTitle}>Eget kapital och skulder (kr)</Text>
        <StatementTable
          rows={data.balansrakning.equity_liabilities}
          hasPrevious={data.previous_period !== null}
        />
      </Page>

      {/* Noter */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} mode={mode} pageLabel="Noter" />
        <Text style={styles.sectionTitle}>Noter</Text>
        {data.noter.map((note) => (
          <View key={note.number} style={{ marginBottom: 16 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
              Not {note.number}: {note.title}
            </Text>
            <Text style={styles.noteBody}>{note.body}</Text>
          </View>
        ))}
      </Page>

      {/* Underskrifter. A version locked for signature keeps the blank
          lines the board fills in by hand; a draft prints who is registered
          and a note instead (signature-pages.ts). */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} mode={mode} pageLabel="Underskrifter" />
        <Text style={styles.sectionTitle}>Underskrifter</Text>
        <SignaturesPdf data={data} mode={mode} styles={styles} />
      </Page>

      {/*
        Fastställelseintyg: required by ÅRL 8 kap 3 § for Bolagsverket
        filing. The intyg confirms that the income statement and balance
        sheet have been adopted at the AGM (årsstämma) and reports the
        AGM's resolution on resultatdisposition. Without this page the
        document cannot be filed as-is: Bolagsverket rejects submissions
        that lack the intyg.

        The intyg is signed by a styrelseledamot or the verkställande
        direktör (product decision 2026-10-15, following the
        swedish-financial-reporting skill, bolagsverket-filing.md § 5;
        ÅRL 8 kap. 3 §): CERTIFICATE_SIGNER in signature-pages.ts.

        Body refers to the AGM's RESOLUTION (stämmobeslut), not the board's
        proposal; the board proposes in förvaltningsberättelsen but the
        AGM votes, and it is the vote that must be certified.

        A draft states that the intyg is filled in after the AGM and prints
        its text only once the AGM date is recorded, never a blank date or
        signature line (signature-pages.ts).
      */}
      <Page size="A4" style={styles.page}>
        <PageChrome data={data} mode={mode} pageLabel="Fastställelseintyg" />
        <Text style={styles.sectionTitle}>Fastställelseintyg</Text>
        {mode === 'draft' && <Text style={styles.draftNote}>{draftCertificateNote(meeting)}</Text>}
        {mode === 'e_signing' && <Text style={styles.draftNote}>{eSigningCertificateNote(meeting)}</Text>}
        {(mode === 'signing' || data.forvaltningsberattelse.agm_date) && (
          <>
            <Text style={styles.paragraph}>
              Undertecknad {CERTIFICATE_SIGNER}, närvarande vid {meeting}, intygar härmed
              att resultaträkningen och balansräkningen har fastställts på {meetingNoun}{' '}
              den {data.forvaltningsberattelse.agm_date ?? '____________________'} och
              att {meeting} beslutade om disposition av {entityNoun} resultat i enlighet
              med vad som anges nedan.
            </Text>
            {mode === 'signing' && <Text style={styles.paragraph}>{PAPER_COPY_CERTIFICATION}</Text>}
            <Text style={styles.paragraph}>
              Jag intygar också att årsredovisningen ger en rättvisande bild av
              företagets ställning och resultat samt att förvaltningsberättelsen ger
              en rättvisande översikt över utvecklingen av företagets verksamhet,
              ställning och resultat.
            </Text>
            <Text style={styles.sectionTitle}>Stämmans beslut om resultatdisposition</Text>
            <Text style={styles.paragraph}>
              {agmDispositionDecision ?? `${isForening ? 'Föreningsstämmans' : 'Årsstämmans'} beslut har ännu inte registrerats.`}
            </Text>
          </>
        )}
        {mode === 'signing' && (
          <>
            <View style={styles.signatureLine}>
              <View style={styles.signatureSlot}>
                <Text> </Text>
              </View>
              <Text style={{ width: 260 }}>{CERTIFICATE_SIGNER_LINE}</Text>
            </View>
            <Text style={[styles.paragraph, { marginTop: 30, fontSize: 9, color: '#666' }]}>
              {data.company.registered_office ? `${data.company.registered_office}, ` : ''}
              datum: {data.forvaltningsberattelse.agm_date ?? '____________________'}
            </Text>
          </>
        )}
      </Page>
    </Document>
  )
}
