import type { ComponentProps } from 'react'
import { Text, View } from '@react-pdf/renderer'
import type { ArsredovisningData } from './types'
import { arsredovisningDatering } from './datering'
import {
  DRAFT_NO_SIGNERS,
  DRAFT_SIGNATURES_NOTE,
  E_SIGNING_SIGNATURES_NOTE,
  type ArsredovisningPdfMode,
  signatureDate,
} from './signature-pages'
import { isAuditorRole } from './workflow-schemas'
import { isEntityType, revisorspateckningLagrum } from '@/lib/company/entity-type'
import { pateckningDatum, pateckningLead, pateckningMening } from '@/lib/bokslut/ixbrl/revisorspateckning'

/**
 * The Underskrifter page body, shared by the K2 and K3 templates: the
 * board's signatures (ÅRL 2 kap. 7 §) in the three renders of
 * signature-pages.ts, then the revisorspåteckning: the revisor's hänvisning to the revisionsberättelse on the
 * årsredovisning (aktiebolag: ABL 9 kap. 28 § andra stycket, every revisor
 * when there are several, 28 a §; ekonomisk förening: 8 kap. 32 § lagen
 * (2018:672) om ekonomiska föreningar). The provision cited comes from the
 * form's profile (revisorspateckningLagrum). The same sentence the iXBRL
 * tags (lib/bokslut/ixbrl/revisorspateckning.ts).
 *
 *   - 'draft': who is registered as revisor and a note on when the
 *     påteckning is made.
 *   - 'signing': the paper copy, with a line per revisor and the date or a
 *     blank to fill in.
 *   - 'e_signing': the copy the board signs with BankID. The revisor is not
 *     in that request (bankid-signing.ts) and the revisionsberättelse is not
 *     given yet, so the copy names the revisor and leaves the påteckning to
 *     the revisor's own signature, without a date or an opinion sentence.
 */

type Style = NonNullable<ComponentProps<typeof View>['style']>
type Styles = Record<
  'sectionTitle' | 'paragraph' | 'draftNote' | 'draftSigner' | 'colLabel' | 'signatureRole' | 'signatureDate' | 'signatureLine' | 'signatureSlot',
  Style
>

/** The provision the form's law has for the påteckning, or null (an unknown form, or no statute). */
function pateckningLagrum(entityType: string | null | undefined): string | null {
  return isEntityType(entityType) ? revisorspateckningLagrum(entityType) : null
}

const cite = (lagrum: string | null): string => (lagrum ? ` (${lagrum})` : '')

/** The draft's note on the påteckning, citing the form's own provision, none when it has none. */
export function draftPateckningNote(lagrum: string | null): string {
  return (
    `Utkast. Revisorn gör en hänvisning till revisionsberättelsen på årsredovisningen när revisionsberättelsen har lämnats${cite(lagrum)}. ` +
    'Påteckningen med datum kommer med i den version som låses för underskrift.'
  )
}

/** The e-signing copy's note on the påteckning, citing the form's own provision, none when it has none. */
export function eSigningPateckningNote(lagrum: string | null): string {
  return (
    `Revisorn gör sin hänvisning till revisionsberättelsen${cite(lagrum)} när revisionsberättelsen har lämnats. ` +
    'Datum för påteckningen framgår av revisorns underskrift.'
  )
}

/** The board's signatures: every renderer of the Underskrifter page lists these. */
export function boardSignatures(data: Pick<ArsredovisningData, 'signatures'>): ArsredovisningData['signatures'] {
  return data.signatures.filter((signature) => !isAuditorRole(signature.role))
}

/**
 * The board's signatures. A version locked for signature keeps the blank
 * lines the board fills in by hand; a draft prints who is registered and a
 * note instead; the e-signing copy carries no date and no line
 * (signature-pages.ts). The revisor's slots follow as the påteckning.
 */
export function SignaturesPdf({
  data,
  mode,
  styles,
}: {
  data: ArsredovisningData
  mode: ArsredovisningPdfMode
  styles: Styles
}) {
  const boardSigners = boardSignatures(data)
  const reportSignatureDate = arsredovisningDatering(boardSigners.map((signature) => signature.signed_at))
  return (
    <>
      {mode === 'draft' ? (
        <>
          <Text style={styles.draftNote}>{DRAFT_SIGNATURES_NOTE}</Text>
          {reportSignatureDate && (
            <Text style={styles.paragraph}>
              {data.company.registered_office ? `${data.company.registered_office}, ` : ''}
              {reportSignatureDate}
            </Text>
          )}
          {boardSigners.length === 0 ? (
            <Text style={styles.paragraph}>{DRAFT_NO_SIGNERS}</Text>
          ) : (
            boardSigners.map((sig, i) => {
              const date = signatureDate(sig.signed_at)
              return (
                <View key={i} style={styles.draftSigner}>
                  <Text style={styles.colLabel}>{sig.name}</Text>
                  <Text style={styles.signatureRole}>{sig.role}</Text>
                  <Text style={styles.signatureDate}>{date ? `Undertecknad ${date}` : ''}</Text>
                </View>
              )
            })
          )}
        </>
      ) : mode === 'e_signing' ? (
        <>
          <Text style={styles.paragraph}>{E_SIGNING_SIGNATURES_NOTE}</Text>
          {data.company.registered_office && <Text style={styles.paragraph}>{data.company.registered_office}</Text>}
          {boardSigners.map((sig, i) => (
            <View key={i} style={styles.draftSigner}>
              <Text style={styles.colLabel}>{sig.name}</Text>
              <Text style={styles.signatureRole}>{sig.role}</Text>
            </View>
          ))}
        </>
      ) : (
        <>
          <Text style={styles.paragraph}>
            {data.company.registered_office ? `${data.company.registered_office}, ` : ''}
            {reportSignatureDate ?? '____________________'}
          </Text>
          {(boardSigners.length > 0
            ? boardSigners
            : [
                { role: 'Styrelseledamot', name: '', signed_at: null },
                { role: 'Styrelseledamot', name: '', signed_at: null },
              ]
          ).map((sig, i) => (
            <View key={i} style={styles.signatureLine}>
              <View style={styles.signatureSlot}>
                <Text>{sig.name || ' '}</Text>
              </View>
              <Text style={styles.signatureRole}>{sig.role}</Text>
              {/* Each signer states the date of their signature (ÅRL 2 kap. 7 §). */}
              <Text style={styles.signatureDate}>
                Datum: {signatureDate(sig.signed_at) ?? '____________'}
              </Text>
            </View>
          ))}
        </>
      )}
      <RevisorspateckningPdf data={data} mode={mode} styles={styles} />
    </>
  )
}

function RevisorspateckningPdf({
  data,
  mode,
  styles,
}: {
  data: ArsredovisningData
  mode: ArsredovisningPdfMode
  styles: Styles
}) {
  const revisorer = data.signatures.filter((signature) => isAuditorRole(signature.role))
  const facts = data.auditor_pateckning ?? null
  if (revisorer.length === 0 && !facts?.required) return null
  const firm = facts?.firm_name ?? null
  const lead = pateckningLead(Math.max(revisorer.length, 1), Boolean(firm))

  if (mode === 'draft') {
    return (
      <View>
        <Text style={styles.sectionTitle}>Revisorspåteckning</Text>
        <Text style={styles.draftNote}>{draftPateckningNote(pateckningLagrum(data.company.entity_type))}</Text>
        {firm && <Text style={styles.paragraph}>{firm}</Text>}
        {revisorer.length === 0 ? (
          <Text style={styles.paragraph}>Ingen revisor är registrerad bland undertecknarna ännu.</Text>
        ) : (
          revisorer.map((revisor, i) => {
            const date = signatureDate(revisor.signed_at)
            return (
              <View key={i} style={styles.draftSigner}>
                <Text style={styles.colLabel}>{revisor.name}</Text>
                <Text style={styles.signatureRole}>{revisor.role}</Text>
                <Text style={styles.signatureDate}>{date ? `Påtecknad ${date}` : ''}</Text>
              </View>
            )
          })
        )}
      </View>
    )
  }

  if (mode === 'e_signing') {
    return (
      <View>
        <Text style={styles.sectionTitle}>Revisorspåteckning</Text>
        <Text style={styles.paragraph}>{eSigningPateckningNote(pateckningLagrum(data.company.entity_type))}</Text>
        {firm && <Text style={styles.paragraph}>{firm}</Text>}
        {revisorer.map((revisor, i) => (
          <View key={i} style={styles.draftSigner}>
            <Text style={styles.colLabel}>{revisor.name}</Text>
            <Text style={styles.signatureRole}>{revisor.role}</Text>
          </View>
        ))}
      </View>
    )
  }

  const datum = pateckningDatum(revisorer.map((revisor) => ({ signedDate: signatureDate(revisor.signed_at) })))
  const mening = pateckningMening(facts?.opinion ?? null, revisorer.length, Boolean(firm))
  return (
    <View>
      <Text style={styles.sectionTitle}>Revisorspåteckning</Text>
      <Text style={styles.paragraph}>
        {lead} {datum ?? '____________________'}.
      </Text>
      {mening && <Text style={styles.paragraph}>{mening}</Text>}
      {firm && <Text style={styles.paragraph}>{firm}</Text>}
      {(revisorer.length > 0 ? revisorer : [{ role: 'Revisor', name: '', signed_at: null }]).map((revisor, i) => (
        <View key={i} style={styles.signatureLine}>
          <View style={styles.signatureSlot}>
            <Text>{revisor.name || ' '}</Text>
          </View>
          <Text style={styles.signatureRole}>{revisor.role}</Text>
          <Text style={styles.signatureDate}> </Text>
        </View>
      ))}
    </View>
  )
}
