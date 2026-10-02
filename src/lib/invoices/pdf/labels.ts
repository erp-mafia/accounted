import { EXPORT_NOTICE_SV } from '@/lib/invoices/vat-rules'
import type { PdfLang } from '@/lib/invoices/pdf/format'

// Customer-facing labels. Statutory chapter references (ML 17 kap 24§, ML 3 kap.)
// stay intact in both locales: they identify the law, not the language.
// Labels keep their colon where the template prints "label value" on one
// line; stacked labels and column headings print them without (bareLabel).
export const PDF_LABELS = {
  sv: {
    // Document titles
    titleInvoice: 'FAKTURA',
    titleCreditNote: 'KREDITFAKTURA',
    titleProforma: 'PROFORMAFAKTURA',
    titleQuote: 'OFFERT',
    titleDeliveryNote: 'FÖLJESEDEL',
    titlePreview: 'FÖRHANDSGRANSKNING',
    // The same documents in running text (running header on pages 2+)
    nameInvoice: 'Faktura',
    nameCreditNote: 'Kreditfaktura',
    nameProforma: 'Proformafaktura',
    nameQuote: 'Offert',
    nameDeliveryNote: 'Följesedel',
    numberPrefix: 'Nr',
    pageOf: (page: number, total: number) => `Sida ${page} av ${total}`,
    // Status stamps
    stampPaid: 'BETALD',
    stampCancelled: 'MAKULERAD',
    stampCredited: 'KREDITERAD',
    draftWatermark: 'UTKAST',
    // Credit note reference (ML 17 kap 22-23 §)
    creditNoteRef: (n: string) => `Denna kreditfaktura avser och krediterar faktura nr ${n}`,
    // Identity band
    fromHeading: 'Från',
    toHeading: 'Till',
    invoiceDate: 'Fakturadatum:',
    // A följesedel is not an invoice: its date is just the date.
    documentDate: 'Datum:',
    dueDate: 'Förfallodatum:',
    // Quote (offert) date labels: a quote has an issue date and an expiry,
    // never a due date.
    quoteDate: 'Offertdatum:',
    validUntil: 'Giltig till:',
    deliveryDate: 'Leveransdatum:',
    yourReference: 'Er referens:',
    ourReference: 'Vår referens:',
    invoiceMarking: 'Märkning:',
    custNo: 'Kundnr:',
    orgNo: 'Org.nr:',
    vat: 'VAT:',
    // Table columns
    colDescription: 'Beskrivning',
    colQty: 'Antal',
    colUnitPrice: 'à-pris',
    colVat: 'Moms',
    colTotal: 'Belopp',
    discountLine: (percent: number) => `Rabatt ${percent} %`,
    // Totals
    subtotal: 'Delsumma:',
    net: (rate: number) => `Netto ${rate}%:`,
    vatRow: (rate: number) => `Moms ${rate}%:`,
    rounding: 'Öresavrundning:',
    deductionRow: 'Skattereduktion ROT/RUT:',
    deductionInfoHeading: 'Underlag för skattereduktion',
    deductionPersonnummer: 'Personnummer:',
    deductionHousingDesignation: 'Fastighetsbeteckning:',
    deductionApartmentNumber: 'Lägenhetsnummer:',
    deductionWorkType: 'Arbete:',
    deductionLaborHours: 'Arbetstimmar:',
    deductionNotice: 'Köparen ansöker om utbetalning hos Skatteverket via fakturamodellen. Säljaren begär utbetalning för den del köparen inte betalat.',
    // Skattereduktion för grön teknik: Skatteverket asks the invoice to state
    // the total and the reduction incl. moms, what the installation cost
    // (arbete och material) apart from övriga kostnader, and the property
    // (fastighetsbeteckning, or the förening's orgnr + lägenhetsnummer).
    deductionRowGronTeknik: 'Skattereduktion grön teknik:',
    totalInclVat: 'Totalt inkl. moms:',
    deductionBrfOrgNumber: 'Bostadsrättsföreningens org.nr:',
    gronTeknikKind: 'Grön teknik',
    gronTeknikEligibleCost: 'Arbete och material:',
    gronTeknikOtherCost: 'Övriga kostnader:',
    inclVatSuffix: 'inkl. moms',
    // Fakturamodellen: the seller requests the payout ("Det är du som
    // företagare som ansöker om utbetalning", Skatteverket, grön teknik).
    gronTeknikPayoutNotice: 'Säljaren begär utbetalningen från Skatteverket när köparen har betalat sin del (fakturamodellen).',
    toCredit: 'Att kreditera:',
    toPay: 'Att betala:',
    // A quote is not a payment request, so its grand total is a neutral sum.
    totalQuote: 'Summa:',
    vatInSek: (rate: number | string) => `Moms i SEK (kurs ${rate}):`,
    totalInSek: 'Totalt i SEK:',
    // Proforma / quote / exempt
    proformaNotice: 'Detta är en proformafaktura och utgör ingen betalningsanmodan.',
    quoteNotice: 'Detta är en offert och utgör ingen faktura eller betalningsanmodan.',
    exemptNotice: 'Undantag från skatteplikt, ML 3 kap.',
    exportNotice: EXPORT_NOTICE_SV,
    notVatRegisteredNotice: 'Företaget är inte momsregistrerat. Mervärdesskatt redovisas ej.',
    // Footer
    orgNoLong: 'Org.nr:',
    vatRegNo: 'Momsreg.nr:',
    fSkatt: 'Godkänd för F-skatt',
  },
  en: {
    titleInvoice: 'INVOICE',
    titleCreditNote: 'CREDIT NOTE',
    titleProforma: 'PROFORMA INVOICE',
    titleQuote: 'QUOTE',
    titleDeliveryNote: 'DELIVERY NOTE',
    titlePreview: 'PREVIEW',
    nameInvoice: 'Invoice',
    nameCreditNote: 'Credit note',
    nameProforma: 'Proforma invoice',
    nameQuote: 'Quote',
    nameDeliveryNote: 'Delivery note',
    numberPrefix: 'No.',
    pageOf: (page: number, total: number) => `Page ${page} of ${total}`,
    stampPaid: 'PAID',
    stampCancelled: 'VOID',
    stampCredited: 'CREDITED',
    draftWatermark: 'DRAFT',
    creditNoteRef: (n: string) => `This credit note credits invoice no. ${n}`,
    fromHeading: 'From',
    toHeading: 'To',
    invoiceDate: 'Invoice date:',
    documentDate: 'Date:',
    dueDate: 'Due date:',
    quoteDate: 'Quote date:',
    validUntil: 'Valid until:',
    deliveryDate: 'Delivery date:',
    yourReference: 'Your reference:',
    ourReference: 'Our reference:',
    invoiceMarking: 'Buyer reference:',
    custNo: 'Customer no.:',
    orgNo: 'Reg. no.:',
    vat: 'VAT:',
    colDescription: 'Description',
    colQty: 'Qty',
    colUnitPrice: 'Unit price',
    colVat: 'VAT',
    colTotal: 'Amount',
    discountLine: (percent: number) => `Discount ${percent}%`,
    subtotal: 'Subtotal:',
    net: (rate: number) => `Net ${rate}%:`,
    vatRow: (rate: number) => `VAT ${rate}%:`,
    rounding: 'Rounding:',
    deductionRow: 'ROT/RUT tax reduction:',
    deductionInfoHeading: 'Tax reduction details',
    deductionPersonnummer: 'Personnummer:',
    deductionHousingDesignation: 'Property designation:',
    deductionApartmentNumber: 'Apartment number:',
    deductionWorkType: 'Service type:',
    deductionLaborHours: 'Labor hours:',
    deductionNotice: 'The customer claims the deduction via fakturamodellen at Skatteverket. The seller requests payment from the agency for the portion not paid by the customer.',
    deductionRowGronTeknik: 'Green technology tax reduction:',
    totalInclVat: 'Total incl. VAT:',
    deductionBrfOrgNumber: 'Housing cooperative org. no.:',
    gronTeknikKind: 'Green technology',
    gronTeknikEligibleCost: 'Labor and material:',
    gronTeknikOtherCost: 'Other costs:',
    inclVatSuffix: 'incl. VAT',
    gronTeknikPayoutNotice: 'The seller requests the payout from Skatteverket once the customer has paid their share (fakturamodellen).',
    toCredit: 'To credit:',
    toPay: 'Total due:',
    totalQuote: 'Total:',
    vatInSek: (rate: number | string) => `VAT in SEK (rate ${rate}):`,
    totalInSek: 'Total in SEK:',
    proformaNotice: 'This is a proforma invoice and is not a request for payment.',
    quoteNotice: 'This is a quote and is not an invoice or a request for payment.',
    exemptNotice: 'Exempt from VAT (ML 3 kap., Swedish VAT Act).',
    exportNotice: 'Sale outside the EU, exempt from Swedish VAT (ML 10 kap., Swedish VAT Act).',
    notVatRegisteredNotice: 'The seller is not VAT-registered. No VAT is charged on this invoice.',
    orgNoLong: 'Reg. no.:',
    vatRegNo: 'VAT reg. no.:',
    // The F-skatt approval must be stated on the invoice, but ML sets no
    // language requirement for invoice text (swedish-invoice-compliance,
    // invoice-rules.md §4). Skatteverket's own English term is "approved for
    // F-tax"; the Swedish phrase stays in parentheses so the literal statutory
    // wording is still on the document. Peppol SE-R-005 (the literal string
    // rule) applies to the UBL file (peppol-bis-billing.ts), which is
    // unaffected by PDF language.
    fSkatt: 'Approved for F-tax (Godkänd för F-skatt)',
  },
} as const

/**
 * Render a stored VAT notice in the document language.
 *
 * reverse_charge_text is stamped in Swedish at create time and stored on the
 * invoice, so an English PDF of an existing export invoice would otherwise
 * print "Omsättning utanför EU, ML 10 kap." verbatim. Known statutory defaults
 * (byte-identical to the constants getVatRules() writes) are rendered from
 * LABELS in the document language; any other text (custom or unknown) is
 * printed exactly as stored.
 */
export function localizeVatNotice(text: string, lang: PdfLang): string {
  if (text === EXPORT_NOTICE_SV) return PDF_LABELS[lang].exportNotice
  return text
}

// Labor-only disclaimer for the ROT/RUT block. Kept Swedish-only in both
// locales: references Skatteverket's fakturamodell directly, which is a
// statutory Swedish concept and has no formal English equivalent.
export const DEDUCTION_LABOR_ONLY_NOTICE =
  'Endast arbetskostnad har inkluderats i underlaget för ROT/RUT-avdrag enligt Skatteverkets fakturamodell.'

// Grön teknik counterpart, Swedish-only for the same reason. Skatteverket
// gives the reduction "för kostnaden för arbete och material", while
// "resor, utrustning eller projektering i samband med installationen" do not
// qualify (Så fungerar skattereduktionen för grön teknik, företag). The box
// already prints both sums ("Arbete och material", "Övriga kostnader"), so
// the notice only states the rule, once, after the per-line breakdown and
// joined with the payout sentence.
export const GRON_TEKNIK_BASE_NOTICE =
  'Skattereduktionen för grön teknik räknas på arbete och material för installationen, inklusive moms; övriga kostnader ingår inte.'
