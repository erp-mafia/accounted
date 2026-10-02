import type { Invoice, InvoiceItem } from '@/types'
import { truncateToWholeKronor } from '@/lib/money'
import {
  isDeductionLine,
  isPastRequestDeadline,
  readClaimBuyer,
  readClaimPayment,
  readClaimProperty,
  readClaimReclaim,
  type ClaimProperty,
  type RotRutBlocker,
  type RotRutBlockerCode,
} from './rot-rut-file'
import {
  GRON_TEKNIK_MAX,
  GRON_TEKNIK_WORK_TYPES,
  deductionSekConverter,
  gronTeknikWorkType,
} from './rot-rut-rules'

/**
 * Skattereduktion för grön teknik: what the payout claim for one invoice is.
 *
 * The payout is requested in Skatteverkets e-tjänst "Grön teknik: företag",
 * by hand or with a Begaran file (Begaran.xsd V1, TypAvBegaran GRON_TEKNIK).
 * This module evaluates a paid invoice against the rules that claim needs and
 * returns exactly the figures an ärende asks for, so the dialog can list them
 * today and the file generator can emit them later from the same evaluation.
 * It emits no XML.
 *
 * What an ärende carries (Begaran.xsd V1 and Skatteverket's example file
 * gron_teknik_exempel.xml, checked 2026-09-30): the buyer, the property,
 * ONE installation type ("Endast en typ av installation kan anges per
 * ärende") with AntalTimmar and Kostnad (arbete och material for the
 * installation), OvrigKostnad, Betalningsdatum, BetaltBelopp and
 * BegartBelopp, all in whole kronor (xs:long). In the example, BetaltBelopp +
 * BegartBelopp = Kostnad, and the e-tjänst refuses "Begärt belopp + Betalt
 * belopp" above "kostnaden för installationen" and a Begärt belopp above
 * Betalt belopp. An invoice with two installation types (solar panels plus a
 * battery) is therefore two ärenden: `installations` holds one entry per
 * type. There is no buyer dimension yet: splitting one invoice between two
 * buyers is #3314 and multiplies these entries per buyer without changing
 * them.
 *
 * Amounts, in SEK:
 *   - kostnad: the flagged lines of the type incl. moms, to the nearest krona
 *     (the same rule as PrisForArbete in the HUS file).
 *   - begart_belopp: the deduction the invoice credited for the type (the
 *     1513 debit), truncated to whole kronor, and never above the type's
 *     rate of the whole-krona kostnad: never ask for more than the invoice
 *     booked, the only direction that cannot breach "Begärt belopp får inte
 *     vara större än Betalt belopp", and never more than the rate allows on
 *     the kostnad the begäran states (33 333.49 kr incl. moms at 15 % books
 *     5 000.02, but the ärende states kostnad 33 333, so 4 999 is the most it
 *     can ask). The remainder clears against 3740 when the payout is settled,
 *     as for ROT/RUT.
 *   - betalt_belopp: kostnad - begart_belopp, what the buyer paid for the
 *     installation (Skatteverket's example: 50 000 SOLCELLER, 7 500 begärt,
 *     42 500 betalt).
 *   - ovrig_kostnad: the invoice's unflagged priced lines incl. moms (travel,
 *     machinery, projektering), whole kronor, never negative.
 * A foreign-currency invoice converts with its booking rate, the same
 * conversion as the 1513 debit, and is blocked without one. Skatteverket's
 * private-person pages mention the rate of the payment day for the buyer's
 * own figures; the file generator has to confirm which rate the begäran
 * expects before emitting foreign invoices.
 *
 * Pure and deterministic: the caller passes the invoice (with items) and
 * `today`; blocker messages are Swedish (statutory surface) and name the
 * first reason that stops the claim.
 */

/** One installation type on the invoice: one ärende in the begäran. */
export interface GronTeknikInstallation {
  /** GRON_TEKNIK_WORK_TYPES code (TypAvUtfortArbete). */
  work_type: string
  /** Skatteverket's label for the type. */
  label: string
  /** Hours summed over the type's lines, whole hours (AntalTimmar, 1-999). */
  antal_timmar: number
  /** Arbete och material incl. moms, whole kronor (Kostnad). */
  kostnad: number
  /** Deduction credited for the type, truncated to whole kronor (BegartBelopp). */
  begart_belopp: number
  /** kostnad - begart_belopp (BetaltBelopp). */
  betalt_belopp: number
}

export interface GronTeknikClaim {
  invoice_id: string
  invoice_number: string | null
  personnummer_last4: string
  /** YYYY-MM-DD, the buyer's payment (Betalningsdatum). */
  betalnings_datum: string
  property: ClaimProperty
  installations: GronTeknikInstallation[]
  /** Unflagged priced lines incl. moms, whole kronor (OvrigKostnad). */
  ovrig_kostnad: number
  /** Sum of the installations' begart_belopp. */
  begart_belopp: number
  /** Non-blocking notices (deadline passed, above the yearly ceiling). Swedish. */
  warnings: string[]
}

export type GronTeknikClaimResult =
  | { ok: true; value: GronTeknikClaim }
  | { ok: false; blocker: RotRutBlocker }

const GRON_TEKNIK_PROPERTY_MISSING =
  'Grön teknik kräver fastighetsbeteckning, eller lägenhetsnummer och bostadsrättsföreningens organisationsnummer. Komplettera fakturan.'

function sekLineTotalInclVat(line: InvoiceItem, toSek: (amount: number) => number): number {
  return toSek(line.line_total ?? 0) + toSek(line.vat_amount ?? 0)
}

export function evaluateGronTeknikClaim(
  invoice: Invoice,
  options: { today?: string } = {},
): GronTeknikClaimResult {
  const block = (code: RotRutBlockerCode, message: string): { ok: false; blocker: RotRutBlocker } => ({
    ok: false,
    blocker: { invoice_id: invoice.id, invoice_number: invoice.invoice_number ?? null, code, message },
  })

  const items = invoice.items ?? []
  const lines = items.filter((i) => isDeductionLine(i, 'gron_teknik'))
  const husLines = items.filter((i) => isDeductionLine(i, 'rot') || isDeductionLine(i, 'rut'))

  const reclaim = readClaimReclaim(invoice)
  if (!reclaim.ok) return block(reclaim.code, reclaim.message)

  if (lines.length === 0) {
    return block(
      'NO_DEDUCTION_OF_TYPE',
      husLines.length > 0
        ? 'Fakturans avdrag är ROT eller RUT: den begärs med en ROT- eller RUT-fil, inte som grön teknik.'
        : 'Fakturan har inga rader med grön teknik.',
    )
  }
  if (husLines.length > 0) {
    return block(
      'MIXED_DEDUCTION_TYPES',
      'Fakturan blandar grön teknik med ROT- eller RUT-rader. Skatteverket prövar dem i olika e-tjänster: dela upp i separata fakturor.',
    )
  }

  // Same header/lines integrity rule as the HUS file: a deduction the header
  // never recorded was never booked to 1513, so there is nothing to request.
  const lineDeductionTotal = lines.reduce((sum, l) => sum + (l.deduction_amount ?? 0), 0)
  if (lineDeductionTotal > 0 && (invoice.deduction_total ?? 0) <= 0) {
    return block(
      'DEDUCTION_TOTAL_MISSING',
      'Fakturan har rader med grön teknik men inget sparat avdragsbelopp: skattereduktionen är inte bokförd mot Skatteverket. Ett utkast kan redigeras direkt; en skickad eller betald faktura rättas med kreditfaktura och en ny faktura.',
    )
  }

  const payment = readClaimPayment(invoice, options.today)
  if (!payment.ok) return block(payment.code, payment.message)
  const paidDate = payment.value

  const buyer = readClaimBuyer(invoice)
  if (!buyer.ok) return block(buyer.code, buyer.message)

  // Group per installation type, in Skatteverket's list order.
  const linesByType = new Map<string, InvoiceItem[]>()
  for (const line of lines) {
    const code = line.work_type?.trim() ?? ''
    if (!code) {
      return block('MISSING_WORK_TYPE', 'Alla rader med grön teknik måste ha en typ av installation. Öppna fakturan och välj typ per rad.')
    }
    if (!gronTeknikWorkType(code)) {
      return block('INVALID_WORK_TYPE', `Typen "${code}" är inte en installation för grön teknik enligt Skatteverkets filformat.`)
    }
    linesByType.set(code, [...(linesByType.get(code) ?? []), line])
  }

  const hoursByType = new Map<string, number>()
  for (const def of GRON_TEKNIK_WORK_TYPES) {
    const typeLines = linesByType.get(def.code)
    if (!typeLines) continue
    const hours = typeLines.reduce(
      (sum, l) => sum + (typeof l.labor_hours === 'number' && l.labor_hours > 0 ? l.labor_hours : 0),
      0,
    )
    if (hours <= 0) {
      return block(
        'MISSING_HOURS',
        `${def.label}: antal arbetade timmar saknas. Skatteverket kräver faktiskt antal timmar för varje installation, även vid fast pris.`,
      )
    }
    const rounded = Math.round(hours)
    if (rounded < 1 || rounded > 999) {
      return block('HOURS_OUT_OF_RANGE', `Antal timmar för ${def.label} måste vara 1-999 (är ${rounded}).`)
    }
    hoursByType.set(def.code, rounded)
  }

  const property = readClaimProperty(lines, GRON_TEKNIK_PROPERTY_MISSING)
  if (!property.ok) return block(property.code, property.message)

  const toSek = deductionSekConverter({ currency: invoice.currency, exchangeRate: invoice.exchange_rate })
  if (!toSek) {
    return block(
      'MISSING_EXCHANGE_RATE',
      `Fakturan är utställd i ${invoice.currency} men saknar växelkurs. Begäran om utbetalning anges alltid i hela kronor: komplettera fakturans växelkurs först.`,
    )
  }

  const installations: GronTeknikInstallation[] = []
  for (const def of GRON_TEKNIK_WORK_TYPES) {
    const typeLines = linesByType.get(def.code)
    if (!typeLines) continue
    const kostnad = Math.round(typeLines.reduce((sum, l) => sum + sekLineTotalInclVat(l, toSek), 0))
    const booked = truncateToWholeKronor(typeLines.reduce((sum, l) => sum + toSek(l.deduction_amount ?? 0), 0))
    const begart = Math.min(booked, truncateToWholeKronor(def.percent * kostnad))
    const betalt = kostnad - begart
    if (begart > betalt) {
      return block(
        'DEDUCTION_EXCEEDS_PAYMENT',
        `${def.label}: begärt belopp (${begart} kr) överstiger vad kunden betalat för installationen (${betalt} kr), och Skatteverket avslår. Kontrollera raderna med grön teknik.`,
      )
    }
    installations.push({
      work_type: def.code,
      label: def.label,
      antal_timmar: hoursByType.get(def.code) ?? 0,
      kostnad,
      begart_belopp: begart,
      betalt_belopp: betalt,
    })
  }

  const begartTotal = installations.reduce((sum, i) => sum + i.begart_belopp, 0)
  if (begartTotal < 1) {
    return block('ZERO_DEDUCTION', 'Fakturans skattereduktion för grön teknik är 0 kr: det finns inget belopp att begära.')
  }

  const ovrigKostnad = Math.max(
    0,
    Math.round(
      items
        .filter((i) => i.line_type !== 'text' && !i.deduction_type)
        .reduce((sum, l) => sum + sekLineTotalInclVat(l, toSek), 0),
    ),
  )

  const warnings: string[] = []
  // The e-tjänst refuses the request itself ("Begärt belopp får inte
  // överstiga gränsen för skattereduktion"), so this is not a matter of
  // Skatteverket granting less.
  if (begartTotal > GRON_TEKNIK_MAX) {
    warnings.push(
      `Begärt belopp (${begartTotal} kr) överstiger årsmaximum ${GRON_TEKNIK_MAX.toLocaleString('sv-SE')} kr per person och år för grön teknik, ` +
        'och e-tjänsten tar inte emot ett begärt belopp över gränsen. Begär högst köparens återstående utrymme; den överskjutande delen får kunden betala.',
    )
  }
  if (options.today && isPastRequestDeadline(paidDate, options.today)) {
    warnings.push(
      `Betalningen (${paidDate}) har passerat sista dag för begäran (31 januari året efter betalningsåret). Skatteverket kan avslå.`,
    )
  }

  return {
    ok: true,
    value: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? null,
      personnummer_last4: buyer.value.slice(-4),
      betalnings_datum: paidDate,
      property: property.value,
      installations,
      ovrig_kostnad: ovrigKostnad,
      begart_belopp: begartTotal,
      warnings,
    },
  }
}
