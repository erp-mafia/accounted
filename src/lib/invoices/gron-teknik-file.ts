import { escapeXml } from '@/lib/xml/escape'
import type { Invoice } from '@/types'
import { evaluateGronTeknikClaim } from './gron-teknik-claim'
import { fileFakturaNr, readClaimBuyer, type RotRutBlocker } from './rot-rut-file'

/**
 * Begäran om utbetalning: grön teknik (Skatteverkets e-tjänst "Grön teknik:
 * företag" → begär utbetalning via fil).
 *
 * Generates the Begaran file, schema V1, for paid grön teknik invoices. As
 * with the HUS file there is no submission API: the user uploads the file and
 * signs the request at Skatteverket.
 *
 * Schema (Skatteverket, "XML-schema för grön teknik", V1, read 2026-11-23):
 *   namespace http://xmls.skatteverket.se/se/skatteverket/skattered/begaran/1.0,
 *   one namespace, elementFormDefault qualified.
 *   Begaran: NamnPaBegaran (token, 1-16), TypAvBegaran (GRON_TEKNIK),
 *     Utforare (the company's org number), Arende 1..n.
 *   Arende, in this order: FakturaNr? (max 20), Kopare (personnummer),
 *     Fastighet? (Fastighetsbeteckning? max 40, LagenhetsNr? max 25,
 *     BrfOrgNr?), UtfortArbete* (TypAvUtfortArbete, AntalTimmar? 0-999,
 *     Kostnad? 0-9 999 999), OvrigKostnad?, Betalningsdatum, Arbetskostnad?
 *     ("Anges endast för arbete av typen rot eller rut": never emitted here),
 *     BetaltBelopp, BegartBelopp. Every amount is whole kronor (xs:long).
 *
 * Rules from Skatteverket's "Regler för att importera fil till grön teknik"
 * that shape the file:
 *   - "Endast en typ av installation kan anges per ärende": an invoice with
 *     solar panels and a battery is two ärenden, one per installation type
 *     (gron-teknik-claim.ts already splits the figures per type).
 *   - "Maximalt antal köpare är 100 st." and V1.1 caps Arende at 100: at most
 *     100 ärenden per file.
 *   - "Betalningsdatum för samtliga köpare ska vara inom samma betalningsår":
 *     one payment year per file.
 *   - The org number must be that of the company the user represents in the
 *     e-tjänst: Utforare is the company's own 12-digit identity, the one
 *     every Skatteverket file carries (companyRedovisare, as in Skatteverket's
 *     example, which states Utforare in 12 digits).
 *
 * Version 1.1 (from 1 January 2027, prop. 2025/26:282) adds the mandatory
 * Underentreprenor and Bemanningsforetag. Skatteverket accepts older versions
 * with those answered by hand in the e-tjänst, so V1 is emitted until
 * Accounted knows the two answers.
 *
 * The figures are evaluateGronTeknikClaim's, the same the eligible list
 * shows: what the list approves, the file emits. Pure and deterministic:
 * the caller passes the invoices, the company's identity and `today`.
 */

const NAMESPACE = 'http://xmls.skatteverket.se/se/skatteverket/skattered/begaran/1.0'

/** At most 100 ärenden per file (see above). */
export const GRON_TEKNIK_MAX_ARENDEN_PER_FILE = 100

/** One ärende in the file: one invoice's one installation type. */
export interface GronTeknikFileArende {
  invoice_id: string
  invoice_number: string | null
  personnummer_last4: string
  betalnings_datum: string
  /** TypAvUtfortArbete. */
  work_type: string
  kostnad: number
  betalt_belopp: number
  begart_belopp: number
}

export interface BuildGronTeknikFileResult {
  /** null when no invoice passed. */
  xml: string | null
  file_name: string
  arenden: GronTeknikFileArende[]
  blockers: RotRutBlocker[]
  /** Non-blocking notices (deadline passed, above the yearly ceiling). Swedish. */
  warnings: string[]
  /** Sum of begart_belopp, whole kronor. */
  requested_total: number
}

interface InvoiceArenden {
  arenden: GronTeknikFileArende[]
  xml: string[]
}

export function buildGronTeknikFile(params: {
  /** NamnPaBegaran: clamped to the schema's 16 characters. */
  name: string
  /** The company's 12-digit identity (companyRedovisare). */
  utforare: string
  invoices: Invoice[]
  /** YYYY-MM-DD, injected for determinism. */
  today: string
}): BuildGronTeknikFileResult {
  const { invoices, today } = params
  const accepted: InvoiceArenden[] = []
  const blockers: RotRutBlocker[] = []
  const warnings: string[] = []
  let arendeCount = 0
  let fileYear: string | null = null

  for (const invoice of invoices) {
    const block = (code: RotRutBlocker['code'], message: string) =>
      blockers.push({ invoice_id: invoice.id, invoice_number: invoice.invoice_number ?? null, code, message })

    const result = evaluateGronTeknikClaim(invoice, { today })
    if (!result.ok) {
      blockers.push(result.blocker)
      continue
    }
    const claim = result.value
    // The claim read the buyer already; the file needs the whole number.
    const buyer = readClaimBuyer(invoice)
    if (!buyer.ok) {
      block(buyer.code, buyer.message)
      continue
    }

    const year = claim.betalnings_datum.slice(0, 4)
    if (fileYear && year !== fileYear) {
      block(
        'MIXED_PAYMENT_YEARS',
        `Fakturan betalades ${year}, men filen innehåller redan betalningar från ${fileYear}. Skatteverket kräver en separat fil per betalningsår.`,
      )
      continue
    }
    if (arendeCount + claim.installations.length > GRON_TEKNIK_MAX_ARENDEN_PER_FILE) {
      block(
        'TOO_MANY_CASES',
        `Skatteverket tillåter högst ${GRON_TEKNIK_MAX_ARENDEN_PER_FILE} ärenden per fil, och varje typ av installation är ett eget ärende. Skapa ytterligare en fil för resten.`,
      )
      continue
    }
    fileYear = year
    arendeCount += claim.installations.length

    const label = claim.invoice_number ?? claim.invoice_id
    for (const warning of claim.warnings) warnings.push(`Faktura ${label}: ${warning}`)

    const fakturaNr = fileFakturaNr(invoice.invoice_number)
    const xml: string[] = []
    const arenden: GronTeknikFileArende[] = []
    claim.installations.forEach((installation, index) => {
      arenden.push({
        invoice_id: claim.invoice_id,
        invoice_number: claim.invoice_number,
        personnummer_last4: claim.personnummer_last4,
        betalnings_datum: claim.betalnings_datum,
        work_type: installation.work_type,
        kostnad: installation.kostnad,
        betalt_belopp: installation.betalt_belopp,
        begart_belopp: installation.begart_belopp,
      })
      xml.push('\t<Arende>')
      if (fakturaNr) xml.push(`\t\t<FakturaNr>${escapeXml(fakturaNr)}</FakturaNr>`)
      xml.push(`\t\t<Kopare>${buyer.value}</Kopare>`)
      xml.push('\t\t<Fastighet>')
      if (claim.property.fastighet) {
        xml.push(`\t\t\t<Fastighetsbeteckning>${escapeXml(claim.property.fastighet)}</Fastighetsbeteckning>`)
      } else {
        xml.push(`\t\t\t<LagenhetsNr>${escapeXml(claim.property.lagenhetsNr ?? '')}</LagenhetsNr>`)
        xml.push(`\t\t\t<BrfOrgNr>${claim.property.brfOrgNr ?? ''}</BrfOrgNr>`)
      }
      xml.push('\t\t</Fastighet>')
      xml.push('\t\t<UtfortArbete>')
      xml.push(`\t\t\t<TypAvUtfortArbete>${installation.work_type}</TypAvUtfortArbete>`)
      xml.push(`\t\t\t<AntalTimmar>${installation.antal_timmar}</AntalTimmar>`)
      xml.push(`\t\t\t<Kostnad>${installation.kostnad}</Kostnad>`)
      xml.push('\t\t</UtfortArbete>')
      // The invoice's övrig kostnad (travel, machinery) is stated once, on
      // its first ärende, so the ärenden add up to the invoice.
      xml.push(`\t\t<OvrigKostnad>${index === 0 ? claim.ovrig_kostnad : 0}</OvrigKostnad>`)
      xml.push(`\t\t<Betalningsdatum>${claim.betalnings_datum}</Betalningsdatum>`)
      xml.push(`\t\t<BetaltBelopp>${installation.betalt_belopp}</BetaltBelopp>`)
      xml.push(`\t\t<BegartBelopp>${installation.begart_belopp}</BegartBelopp>`)
      xml.push('\t</Arende>')
    })
    accepted.push({ arenden, xml })
  }

  const fileName = `gron_teknik_begaran_${today}.xml`
  const arenden = accepted.flatMap((a) => a.arenden)
  if (arenden.length === 0) {
    return { xml: null, file_name: fileName, arenden, blockers, warnings, requested_total: 0 }
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Begaran xmlns="${NAMESPACE}">`,
    `\t<NamnPaBegaran>${escapeXml(params.name.slice(0, 16))}</NamnPaBegaran>`,
    '\t<TypAvBegaran>GRON_TEKNIK</TypAvBegaran>',
    `\t<Utforare>${params.utforare}</Utforare>`,
    ...accepted.flatMap((a) => a.xml),
    '</Begaran>',
  ]

  return {
    xml: lines.join('\n'),
    file_name: fileName,
    arenden,
    blockers,
    warnings,
    requested_total: arenden.reduce((sum, a) => sum + a.begart_belopp, 0),
  }
}
