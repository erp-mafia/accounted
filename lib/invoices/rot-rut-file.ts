import type { Invoice, InvoiceItem } from '@/types'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { DeductionType } from './rot-rut-rules'

/**
 * Begäran om utbetalning: rot & rut (Skatteverkets husavdragstjänst).
 *
 * Generates the HUS XML file (schema V6) that is uploaded manually on
 * Skatteverkets e-tjänst "Rot och rut: företag" → "Begär utbetalning via
 * fil". There is NO submission API: the file replaces per-ärende manual
 * entry, the upload + signature (e-legitimation) stays with the user.
 *
 * Schema (vendored in dev_docs/skatteverket/husavdrag/):
 *   root:  http://xmls.skatteverket.se/se/skatteverket/ht/begaran/6.0
 *   types: http://xmls.skatteverket.se/se/skatteverket/ht/komponent/begaran/6.0
 *
 * Hard schema facts honoured here:
 *   - Rot and rut can NEVER be mixed in one file (choice of RotBegaran |
 *     HushallBegaran). One file per deduction type.
 *   - All amounts are whole kronor (xs:long). PrisForArbete min 2.
 *   - Kopare is a 12-digit personnummer.
 *   - NamnPaBegaran is 1-16 characters.
 *   - Element order inside an ärende is fixed: base fields, then (rot only)
 *     property fields, then UtfortArbete.
 *   - Ovrigkostnad is mandatory as soon as UtfortArbete reports hours or
 *     material. Accounted doesn't itemize övrig kostnad (travel/machines):
 *     materials live on non-deduction rows: so 0 is emitted.
 *
 * Everything in this module is pure and deterministic: the caller passes the
 * invoices and `today`; blockers are named per invoice, never guessed.
 * File content stays Swedish (statutory surface, see .claude/rules/i18n.md).
 */

const ROOT_NS = 'http://xmls.skatteverket.se/se/skatteverket/ht/begaran/6.0'
const KOMPONENT_NS = 'http://xmls.skatteverket.se/se/skatteverket/ht/komponent/begaran/6.0'

/**
 * work_type code → XSD element. Array order = the XSD sequence order, which
 * is also the emission order inside UtfortArbete. `schablon` services are
 * reported as <Utfort>true</Utfort>: no hours, no material.
 */
const WORK_TYPE_ELEMENTS: Record<DeductionType, ReadonlyArray<{
  code: string
  element: string
  schablon?: boolean
}>> = {
  rot: [
    { code: 'BYGG', element: 'Bygg' },
    { code: 'EL', element: 'El' },
    { code: 'GLAS_PLAT', element: 'GlasPlatarbete' },
    { code: 'MARK_DRAN', element: 'MarkDraneringarbete' },
    { code: 'MURNING', element: 'Murning' },
    { code: 'MALNING', element: 'MalningTapetsering' },
    { code: 'VVS', element: 'Vvs' },
  ],
  rut: [
    { code: 'STAD', element: 'Stadning' },
    { code: 'KLAD', element: 'KladOchTextilvard' },
    { code: 'SNOSKOTTNING', element: 'Snoskottning' },
    { code: 'TRADGARD', element: 'Tradgardsarbete' },
    { code: 'BARNPASS', element: 'Barnpassning' },
    { code: 'PERSONLIG_OMS', element: 'Personligomsorg' },
    { code: 'FLYTT', element: 'Flyttjanster' },
    { code: 'IT', element: 'ItTjanster' },
    { code: 'REPARATION', element: 'ReparationAvVitvaror' },
    { code: 'MOBLERING', element: 'Moblering' },
    { code: 'TILLSYN', element: 'TillsynAvBostad' },
    { code: 'TRANSPORT', element: 'TransportTillForsaljning', schablon: true },
    { code: 'TVATT', element: 'TvattVidTvattinrattning', schablon: true },
  ],
}

export type RotRutBlockerCode =
  | 'NOT_PAID'
  | 'MISSING_PAYMENT_DATE'
  | 'NO_DEDUCTION_OF_TYPE'
  | 'MIXED_DEDUCTION_TYPES'
  | 'MISSING_PERSONNUMMER'
  | 'PERSONNUMMER_UNREADABLE'
  | 'MISSING_WORK_TYPE'
  | 'INVALID_WORK_TYPE'
  | 'MISSING_HOURS'
  | 'HOURS_OUT_OF_RANGE'
  | 'MISSING_PROPERTY'
  | 'INVALID_BRF_ORGNR'
  | 'PROPERTY_TOO_LONG'
  | 'PRICE_BELOW_MINIMUM'
  | 'DEDUCTION_EXCEEDS_PAYMENT'
  | 'ZERO_DEDUCTION'

export interface RotRutBlocker {
  invoice_id: string
  invoice_number: string | null
  code: RotRutBlockerCode
  /** Swedish: shown as-is in UI and MCP output (statutory surface). */
  message: string
}

/** One ärende (buyer + invoice) accepted into the file. */
export interface RotRutArende {
  invoice_id: string
  invoice_number: string | null
  personnummer_last4: string
  betalnings_datum: string
  /** Whole kronor, as emitted. */
  pris_for_arbete: number
  betalt_belopp: number
  begart_belopp: number
}

export interface BuildRotRutFileResult {
  /** null when no invoice passed eligibility. */
  xml: string | null
  file_name: string
  arenden: RotRutArende[]
  blockers: RotRutBlocker[]
  /** Non-blocking notices (e.g. deadline passed). Swedish. */
  warnings: string[]
  /** Sum of begart_belopp, whole kronor. */
  requested_total: number
}

interface EvaluatedArende {
  arende: RotRutArende
  /** Emission-ready fragments, in XSD order. */
  kopare: string
  fakturaNr: string | null
  property: { fastighet?: string; lagenhetsNr?: string; brfOrgNr?: string } | null
  /** element name → { hours, schablon } aggregated over lines. */
  work: Array<{ element: string; schablon: boolean; hours: number }>
}

function isDeductionLine(item: InvoiceItem, type: DeductionType): boolean {
  return item.deduction_type === type && item.line_type !== 'text'
}

/**
 * Normalize a BRF orgnr to the 12-digit form Skatteverkets exempel uses
 * (sekelsiffra 16 + 10-digit orgnr). Returns null when the input can't be
 * normalized deterministically.
 */
export function normalizeBrfOrgNr(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  // 12-digit orgnr must carry sekelsiffra 16 (juridisk person): anything
  // else is not a valid Swedish orgnr and fails SKV's schema at upload.
  if (digits.length === 12) return digits.startsWith('16') ? digits : null
  if (digits.length === 10) return `16${digits}`
  return null
}

/**
 * Evaluate one invoice against the file rules for `type`. Returns either an
 * emission-ready ärende or the FIRST blocker hit (one clear reason beats a
 * pile). Exported so the eligible-list API can show per-invoice reasons with
 * exactly the same logic that later generates the file.
 */
export function evaluateInvoiceForFile(
  type: DeductionType,
  invoice: Invoice,
): { ok: true; value: EvaluatedArende } | { ok: false; blocker: RotRutBlocker } {
  const block = (code: RotRutBlockerCode, message: string): { ok: false; blocker: RotRutBlocker } => ({
    ok: false,
    blocker: { invoice_id: invoice.id, invoice_number: invoice.invoice_number ?? null, code, message },
  })

  const items = invoice.items ?? []
  const typeLines = items.filter((i) => isDeductionLine(i, type))
  const otherType: DeductionType = type === 'rot' ? 'rut' : 'rot'
  const otherLines = items.filter((i) => isDeductionLine(i, otherType))

  if (typeLines.length === 0) {
    return block('NO_DEDUCTION_OF_TYPE', `Fakturan har inga ${type.toUpperCase()}-rader.`)
  }
  // One invoice must map to exactly one ärende in exactly one file. Mixed
  // rot+rut invoices would need to live in two active begäran at once, which
  // the double-request guard (rightly) refuses: ask the user to split.
  if (otherLines.length > 0) {
    return block(
      'MIXED_DEDUCTION_TYPES',
      'Fakturan blandar ROT- och RUT-rader. Skatteverket tillåter inte båda i samma fil: dela upp i separata fakturor.',
    )
  }

  if (invoice.status !== 'paid') {
    return block('NOT_PAID', 'Kunden måste ha betalat sin del av fakturan innan utbetalning kan begäras.')
  }
  const paidDate = invoice.paid_at ? String(invoice.paid_at).slice(0, 10) : null
  if (!paidDate) {
    return block('MISSING_PAYMENT_DATE', 'Fakturan saknar betalningsdatum.')
  }

  if (!invoice.deduction_personnummer_encrypted) {
    return block('MISSING_PERSONNUMMER', 'Fakturan saknar köparens personnummer.')
  }
  let kopare: string
  try {
    kopare = decryptPersonnummer(invoice.deduction_personnummer_encrypted).replace(/\D/g, '')
  } catch {
    return block('PERSONNUMMER_UNREADABLE', 'Köparens personnummer kunde inte läsas: öppna fakturautkastet och ange det igen.')
  }
  if (kopare.length !== 12) {
    return block('PERSONNUMMER_UNREADABLE', 'Köparens personnummer är inte 12 siffror.')
  }

  // Aggregate hours per work type, in XSD element order.
  const elementMap = WORK_TYPE_ELEMENTS[type]
  const hoursByCode = new Map<string, number>()
  for (const line of typeLines) {
    const code = line.work_type ?? ''
    if (!code) {
      return block('MISSING_WORK_TYPE', 'Alla ROT/RUT-rader måste ha en arbetstyp. Öppna fakturan och välj arbetstyp per rad.')
    }
    const def = elementMap.find((e) => e.code === code)
    if (!def) {
      return block(
        'INVALID_WORK_TYPE',
        `Arbetstypen "${code}" är inte giltig för ${type.toUpperCase()} enligt Skatteverkets filformat.`,
      )
    }
    if (!def.schablon) {
      const hours = line.labor_hours ?? 0
      if (hours <= 0) {
        return block('MISSING_HOURS', 'Alla ROT/RUT-rader måste ha antal arbetstimmar (schablontjänster undantagna).')
      }
      hoursByCode.set(code, (hoursByCode.get(code) ?? 0) + hours)
    } else {
      hoursByCode.set(code, hoursByCode.get(code) ?? 0)
    }
  }

  const work: EvaluatedArende['work'] = []
  for (const def of elementMap) {
    if (!hoursByCode.has(def.code)) continue
    const hours = Math.round(hoursByCode.get(def.code) ?? 0)
    if (!def.schablon && (hours < 1 || hours > 999)) {
      return block('HOURS_OUT_OF_RANGE', `Antal timmar för ${def.element} måste vara 1-999 (är ${hours}).`)
    }
    work.push({ element: def.element, schablon: def.schablon === true, hours })
  }

  // Property info (rot only): fastighetsbeteckning OR lägenhetsnummer + BRF
  // orgnr, read off the rot lines (stamped there at save time).
  let property: EvaluatedArende['property'] = null
  if (type === 'rot') {
    const fastighet = typeLines.map((l) => l.housing_designation?.trim()).find(Boolean) ?? null
    const lagenhet = typeLines.map((l) => l.apartment_number?.trim()).find(Boolean) ?? null
    const brfRaw = typeLines.map((l) => l.brf_org_number?.trim()).find(Boolean) ?? null

    if (brfRaw && lagenhet) {
      const brf = normalizeBrfOrgNr(brfRaw)
      if (!brf) {
        return block('INVALID_BRF_ORGNR', `Föreningens organisationsnummer "${brfRaw}" är ogiltigt (10 eller 12 siffror krävs).`)
      }
      if (lagenhet.length > 25) {
        return block('PROPERTY_TOO_LONG', 'Lägenhetsnumret är längre än 25 tecken.')
      }
      property = { lagenhetsNr: lagenhet, brfOrgNr: brf }
    } else if (fastighet) {
      if (fastighet.length > 40) {
        return block('PROPERTY_TOO_LONG', 'Fastighetsbeteckningen är längre än 40 tecken (Skatteverkets maxlängd).')
      }
      property = { fastighet }
    } else {
      return block(
        'MISSING_PROPERTY',
        'ROT kräver fastighetsbeteckning eller lägenhetsnummer + föreningens orgnr. Komplettera fakturan.',
      )
    }
  }

  // Amounts, whole kronor. PrisForArbete = arbetskostnad inkl moms for the
  // flagged lines; BegartBelopp mirrors the deduction the invoice actually
  // credited (1513); BetaltBelopp = what the buyer paid for the work.
  const prisForArbete = Math.round(
    typeLines.reduce((sum, l) => sum + (l.line_total ?? 0) + (l.vat_amount ?? 0), 0),
  )
  const begartBelopp = Math.round(
    typeLines.reduce((sum, l) => sum + (l.deduction_amount ?? 0), 0),
  )
  const betaltBelopp = prisForArbete - begartBelopp
  if (prisForArbete < 2) {
    return block('PRICE_BELOW_MINIMUM', 'Arbetskostnaden måste vara minst 2 kr (Skatteverkets filformat).')
  }
  // A zero-kronor ärende is rejected (or silently ignored) by Skatteverket:
  // an invoice whose deduction rounds to 0 has nothing to request.
  if (begartBelopp < 1) {
    return block('ZERO_DEDUCTION', 'Fakturans ROT/RUT-avdrag är 0 kr: det finns inget belopp att begära.')
  }
  // The buyer must have paid at least as much as is being requested
  // (skattereduktionen är max 50 % av arbetskostnaden). Independent rounding
  // of pris/begärt could otherwise even push BetaltBelopp negative, which
  // Skatteverkets schema rejects outright.
  if (begartBelopp > betaltBelopp) {
    return block(
      'DEDUCTION_EXCEEDS_PAYMENT',
      `Begärt belopp (${begartBelopp} kr) överstiger vad kunden betalat för arbetet (${betaltBelopp} kr): Skatteverket avslår. Kontrollera avdragsraderna.`,
    )
  }

  return {
    ok: true,
    value: {
      arende: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        personnummer_last4: kopare.slice(-4),
        betalnings_datum: paidDate,
        pris_for_arbete: prisForArbete,
        betalt_belopp: betaltBelopp,
        begart_belopp: begartBelopp,
      },
      kopare,
      fakturaNr: invoice.invoice_number ? String(invoice.invoice_number).slice(0, 20) : null,
      property,
      work,
    },
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * The 31 January deadline: a begäran must reach Skatteverket no later than
 * 31 January the year AFTER the buyer paid. Returns true when `paidDate`'s
 * window has closed as of `today` (both YYYY-MM-DD).
 */
export function isPastRequestDeadline(paidDate: string, today: string): boolean {
  const paidYear = Number(paidDate.slice(0, 4))
  const deadline = `${paidYear + 1}-01-31`
  return today > deadline
}

export function buildRotRutFile(params: {
  type: DeductionType
  /** NamnPaBegaran: clamped to the XSD's 16-char cap. */
  name: string
  invoices: Invoice[]
  /** YYYY-MM-DD, injected for determinism. */
  today: string
}): BuildRotRutFileResult {
  const { type, invoices, today } = params

  const arenden: RotRutArende[] = []
  const evaluated: EvaluatedArende[] = []
  const blockers: RotRutBlocker[] = []
  const warnings: string[] = []

  for (const invoice of invoices) {
    const result = evaluateInvoiceForFile(type, invoice)
    if (!result.ok) {
      blockers.push(result.blocker)
      continue
    }
    evaluated.push(result.value)
    arenden.push(result.value.arende)
    if (isPastRequestDeadline(result.value.arende.betalnings_datum, today)) {
      warnings.push(
        `Faktura ${result.value.arende.invoice_number ?? result.value.arende.invoice_id}: betalningen (${result.value.arende.betalnings_datum}) har passerat sista begäransdatum (31 januari året efter betalningsåret). Skatteverket kan avslå.`,
      )
    }
  }

  const fileName = `${type}_begaran_${today}.xml`

  if (evaluated.length === 0) {
    return { xml: null, file_name: fileName, arenden, blockers, warnings, requested_total: 0 }
  }

  const name = escapeXml(params.name.slice(0, 16))
  const wrapper = type === 'rot' ? 'RotBegaran' : 'HushallBegaran'

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<ns1:Begaran xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns1="${ROOT_NS}" xmlns:ns2="${KOMPONENT_NS}">`,
  )
  lines.push(`\t<ns2:NamnPaBegaran>${name}</ns2:NamnPaBegaran>`)
  lines.push(`\t<ns2:${wrapper}>`)

  for (const ev of evaluated) {
    lines.push('\t\t<ns2:Arenden>')
    lines.push(`\t\t\t<ns2:Kopare>${ev.kopare}</ns2:Kopare>`)
    lines.push(`\t\t\t<ns2:BetalningsDatum>${ev.arende.betalnings_datum}</ns2:BetalningsDatum>`)
    lines.push(`\t\t\t<ns2:PrisForArbete>${ev.arende.pris_for_arbete}</ns2:PrisForArbete>`)
    lines.push(`\t\t\t<ns2:BetaltBelopp>${ev.arende.betalt_belopp}</ns2:BetaltBelopp>`)
    lines.push(`\t\t\t<ns2:BegartBelopp>${ev.arende.begart_belopp}</ns2:BegartBelopp>`)
    if (ev.fakturaNr) {
      lines.push(`\t\t\t<ns2:FakturaNr>${escapeXml(ev.fakturaNr)}</ns2:FakturaNr>`)
    }
    // Mandatory when UtfortArbete reports hours; Accounted books övriga
    // kostnader (resor, maskiner) outside the deduction rows → always 0.
    lines.push('\t\t\t<ns2:Ovrigkostnad>0</ns2:Ovrigkostnad>')
    if (ev.property?.fastighet) {
      lines.push(`\t\t\t<ns2:Fastighetsbeteckning>${escapeXml(ev.property.fastighet)}</ns2:Fastighetsbeteckning>`)
    }
    if (ev.property?.lagenhetsNr) {
      lines.push(`\t\t\t<ns2:LagenhetsNr>${escapeXml(ev.property.lagenhetsNr)}</ns2:LagenhetsNr>`)
      lines.push(`\t\t\t<ns2:BrfOrgNr>${ev.property.brfOrgNr}</ns2:BrfOrgNr>`)
    }
    if (ev.work.length > 0) {
      lines.push('\t\t\t<ns2:UtfortArbete>')
      for (const w of ev.work) {
        if (w.schablon) {
          lines.push(`\t\t\t\t<ns2:${w.element}>`)
          lines.push('\t\t\t\t\t<ns2:Utfort>true</ns2:Utfort>')
          lines.push(`\t\t\t\t</ns2:${w.element}>`)
        } else {
          lines.push(`\t\t\t\t<ns2:${w.element}>`)
          lines.push(`\t\t\t\t\t<ns2:AntalTimmar>${w.hours}</ns2:AntalTimmar>`)
          // Materials are invoiced on non-deduction rows in Accounted's
          // fakturamodell: the file reports 0 (XSD requires the element).
          lines.push('\t\t\t\t\t<ns2:Materialkostnad>0</ns2:Materialkostnad>')
          lines.push(`\t\t\t\t</ns2:${w.element}>`)
        }
      }
      lines.push('\t\t\t</ns2:UtfortArbete>')
    }
    lines.push('\t\t</ns2:Arenden>')
  }

  lines.push(`\t</ns2:${wrapper}>`)
  lines.push('</ns1:Begaran>')

  const requestedTotal = arenden.reduce((sum, a) => sum + a.begart_belopp, 0)

  return {
    xml: lines.join('\n'),
    file_name: fileName,
    arenden,
    blockers,
    warnings,
    requested_total: requestedTotal,
  }
}
