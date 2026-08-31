// Deterministic generator for the extraction suite's document corpus.
//
//   npx tsx bench/scripts/generate-extraction-docs.ts
//
// Renders 12 synthetic Swedish documents (invoices, receipts, credit notes)
// as PDF with pdf-lib, rasterizes each to PNG via pdftoppm (the PNG is the
// committed input artifact every model sees), and writes the gold task file
// tasks/extraction/docs.json FROM THE SAME CONSTANTS, so document and gold
// can never drift apart.
//
// All suppliers, org numbers and amounts are synthetic. Org numbers are
// Luhn-valid but use the 555xxx test range; OCR references are Luhn-valid.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tasks',
  'extraction',
)
const DOCS_DIR = path.join(OUT, 'documents')
fs.mkdirSync(DOCS_DIR, { recursive: true })

// --- number helpers --------------------------------------------------------

function luhnCheckDigit(digits: string): number {
  // Standard Luhn: doubling starts from the rightmost digit of the base.
  let sum = 0
  const reversed = digits.split('').reverse()
  for (let i = 0; i < reversed.length; i++) {
    let d = Number(reversed[i])
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

function orgNumber(base9: string): string {
  if (!/^\d{9}$/.test(base9)) throw new Error('need 9 digits')
  const check = luhnCheckDigit(base9)
  return `${base9.slice(0, 6)}-${base9.slice(6)}${check}`
}

function ocrRef(base: string): string {
  return base + String(luhnCheckDigit(base))
}

function sek(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const whole = Math.trunc(abs)
  const dec = Math.round((abs - whole) * 100)
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}${grouped},${String(dec).padStart(2, '0')}`
}

// --- document model --------------------------------------------------------

interface Line {
  text: string
  qty: number
  unitPrice: number | null
  total: number
  vatRate: number
}

interface DocSpec {
  id: string
  file: string
  difficulty: 'core' | 'hard' | 'expert'
  probe: string
  font: 'helvetica' | 'times' | 'courier'
  kind: 'invoice' | 'receipt' | 'credit_note'
  supplier: {
    name: string
    org: string | null
    vat: string | null
    address: string
    bankgiro: string | null
    plusgiro: string | null
  }
  buyer?: { name: string; vat?: string }
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  ocr: string | null
  currency: 'SEK' | 'EUR'
  lines: Line[]
  rounding: number | null
  notes: string[]
  servicePeriod?: { start: string; end: string }
  cardNote?: string
}

function totals(spec: DocSpec) {
  const byRate = new Map<number, { base: number; amount: number }>()
  let subtotal = 0
  for (const line of spec.lines) {
    subtotal += line.total
    const bucket = byRate.get(line.vatRate) ?? { base: 0, amount: 0 }
    bucket.base += line.total
    bucket.amount += (line.total * line.vatRate) / 100
    byRate.set(line.vatRate, bucket)
  }
  const r2 = (x: number) => Math.round(x * 100) / 100
  const breakdown = [...byRate.entries()]
    .filter(([rate]) => rate > 0)
    .map(([rate, v]) => ({ rate, base: r2(v.base), amount: r2(v.amount) }))
    .sort((a, b) => b.rate - a.rate)
  const vatAmount = r2(breakdown.reduce((s, b) => s + b.amount, 0))
  const rounding = spec.rounding ?? 0
  const total = r2(subtotal + vatAmount + rounding)
  return { subtotal: r2(subtotal), vatAmount, breakdown, total }
}

// --- corpus ----------------------------------------------------------------

const ORG_KONSULT = orgNumber('556901234')
const ORG_REST = orgNumber('556812345')
const ORG_BYGG = orgNumber('556734567')
const ORG_TELE = orgNumber('556645678')
const ORG_HYRA = orgNumber('556567890')
const ORG_BOK = orgNumber('556478901')
const ORG_EL = orgNumber('556389012')

const vatOf = (org: string) => `SE${org.replace('-', '')}01`

const DOCS: DocSpec[] = [
  {
    id: 'extraction-001',
    file: 'e01-konsultfaktura',
    difficulty: 'core',
    probe: 'Plain 25 % services invoice with bankgiro and OCR',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Nordkonsult Systemutveckling AB',
      org: ORG_KONSULT,
      vat: vatOf(ORG_KONSULT),
      address: 'Sveavägen 42, 111 34 Stockholm',
      bankgiro: '5432-1098',
      plusgiro: null,
    },
    invoiceNumber: '2026-1041',
    invoiceDate: '2026-05-04',
    dueDate: '2026-06-03',
    ocr: ocrRef('20261041'),
    currency: 'SEK',
    lines: [
      { text: 'Systemutveckling, sprint 18 (80 h à 1 150 kr)', qty: 80, unitPrice: 1150, total: 92000, vatRate: 25 },
      { text: 'Projektledning maj (12 h à 1 350 kr)', qty: 12, unitPrice: 1350, total: 16200, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Betalningsvillkor 30 dagar. Dröjsmålsränta enligt räntelagen.', 'Godkänd för F-skatt.'],
  },
  {
    id: 'extraction-002',
    file: 'e02-restaurangkvitto',
    difficulty: 'hard',
    probe: 'Receipt with mixed 12/25 % VAT and öresavrundning',
    font: 'courier',
    kind: 'receipt',
    supplier: {
      name: 'Restaurang Gyllene Gaffeln AB',
      org: ORG_REST,
      vat: vatOf(ORG_REST),
      address: 'Storgatan 7, 411 24 Göteborg',
      bankgiro: null,
      plusgiro: null,
    },
    invoiceNumber: 'K-88412',
    invoiceDate: '2026-04-17',
    dueDate: null,
    ocr: null,
    currency: 'SEK',
    lines: [
      { text: 'Dagens lunch 2 x 145,00', qty: 2, unitPrice: 145, total: 290, vatRate: 12 },
      { text: 'Mineralvatten 2 x 32,00', qty: 2, unitPrice: 32, total: 64, vatRate: 12 },
      { text: 'Lättöl 1 x 58,00', qty: 1, unitPrice: 58, total: 58, vatRate: 25 },
    ],
    rounding: 0.06,
    notes: ['Betalat med kort **** 4411 kl 12:41'],
    cardNote: 'VISA KORTKÖP **** 4411',
  },
  {
    id: 'extraction-003',
    file: 'e03-blandmoms',
    difficulty: 'hard',
    probe: 'Invoice with three VAT rates (25/12/6)',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Eventpartner Syd AB',
      org: ORG_BYGG,
      vat: vatOf(ORG_BYGG),
      address: 'Hamngatan 3, 211 22 Malmö',
      bankgiro: '7788-9900',
      plusgiro: null,
    },
    invoiceNumber: 'F-5520',
    invoiceDate: '2026-03-09',
    dueDate: '2026-03-29',
    ocr: ocrRef('55203'),
    currency: 'SEK',
    lines: [
      { text: 'Konferenslokal heldag', qty: 1, unitPrice: 18000, total: 18000, vatRate: 25 },
      { text: 'Konferenslunch 24 kuvert', qty: 24, unitPrice: 285, total: 6840, vatRate: 12 },
      { text: 'Busstransfer Malmö C-anläggningen', qty: 1, unitPrice: 3200, total: 3200, vatRate: 6 },
    ],
    rounding: null,
    notes: ['Vid försenad betalning debiteras påminnelseavgift 60 kr.'],
  },
  {
    id: 'extraction-004',
    file: 'e04-eu-reverse-charge',
    difficulty: 'hard',
    probe: 'EU reverse-charge invoice in EUR, 0 % VAT, both VAT numbers',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'CloudMetrics Software GmbH',
      org: null,
      vat: 'DE298765432',
      address: 'Rosenthaler Str. 8, 10119 Berlin, Germany',
      bankgiro: null,
      plusgiro: null,
    },
    buyer: { name: 'Accounted Demo AB', vat: 'SE556677889901' },
    invoiceNumber: 'INV-2026-8804',
    invoiceDate: '2026-06-01',
    dueDate: '2026-06-15',
    ocr: null,
    currency: 'EUR',
    lines: [
      { text: 'CloudMetrics Team plan, June 2026 (10 seats)', qty: 10, unitPrice: 24, total: 240, vatRate: 0 },
    ],
    rounding: null,
    notes: [
      'VAT 0%. Reverse charge: VAT to be accounted for by the recipient under Article 196 of Directive 2006/112/EC.',
    ],
  },
  {
    id: 'extraction-005',
    file: 'e05-kreditfaktura',
    difficulty: 'expert',
    probe: 'Credit note with negative amounts referencing the original invoice',
    font: 'times',
    kind: 'credit_note',
    supplier: {
      name: 'Nordkonsult Systemutveckling AB',
      org: ORG_KONSULT,
      vat: vatOf(ORG_KONSULT),
      address: 'Sveavägen 42, 111 34 Stockholm',
      bankgiro: '5432-1098',
      plusgiro: null,
    },
    invoiceNumber: 'K-2026-1041',
    invoiceDate: '2026-05-20',
    dueDate: null,
    ocr: null,
    currency: 'SEK',
    lines: [
      { text: 'Kreditering: felfakturerade timmar sprint 18 (avser faktura 2026-1041)', qty: 8, unitPrice: -1150, total: -9200, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Kreditfaktura. Avser faktura 2026-1041 av 2026-05-04.'],
  },
  {
    id: 'extraction-006',
    file: 'e06-hyresavi',
    difficulty: 'hard',
    probe: 'Rent invoice with service period (periodisering signal)',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Fastighets AB Södra Porten',
      org: ORG_HYRA,
      vat: vatOf(ORG_HYRA),
      address: 'Box 119, 601 03 Norrköping',
      bankgiro: '332-5511',
      plusgiro: null,
    },
    invoiceNumber: 'HA-2026-Q3-118',
    invoiceDate: '2026-06-05',
    dueDate: '2026-06-30',
    ocr: ocrRef('2026118'),
    currency: 'SEK',
    lines: [
      { text: 'Lokalhyra kv 3 2026, lokal 2 tr (frivillig skattskyldighet)', qty: 1, unitPrice: 54000, total: 54000, vatRate: 25 },
      { text: 'El enligt förbrukning kv 2', qty: 1, unitPrice: 2140, total: 2140, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Hyresperiod: 2026-07-01 - 2026-09-30.'],
    servicePeriod: { start: '2026-07-01', end: '2026-09-30' },
  },
  {
    id: 'extraction-007',
    file: 'e07-plusgiro',
    difficulty: 'core',
    probe: 'Plusgiro-only supplier: bankgiro must be null',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Bokbindarna i Uppsala HB',
      org: ORG_BOK,
      vat: vatOf(ORG_BOK),
      address: 'Kungsängsgatan 12, 753 22 Uppsala',
      bankgiro: null,
      plusgiro: '48 77 22-3',
    },
    invoiceNumber: '1187',
    invoiceDate: '2026-02-12',
    dueDate: '2026-03-14',
    ocr: null,
    currency: 'SEK',
    lines: [
      { text: 'Inbindning årsredovisningar, 6 ex', qty: 6, unitPrice: 290, total: 1740, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Ange fakturanummer 1187 vid betalning.'],
  },
  {
    id: 'extraction-008',
    file: 'e08-kassakvitto',
    difficulty: 'core',
    probe: 'Simple card receipt',
    font: 'courier',
    kind: 'receipt',
    supplier: {
      name: 'Kontorsgrossisten Sverige AB',
      org: ORG_EL,
      vat: vatOf(ORG_EL),
      address: 'Backavägen 5, 417 05 Göteborg',
      bankgiro: null,
      plusgiro: null,
    },
    invoiceNumber: '774921',
    invoiceDate: '2026-05-27',
    dueDate: null,
    ocr: null,
    currency: 'SEK',
    lines: [
      { text: 'Skrivarpapper A4 5-pack', qty: 2, unitPrice: 189, total: 378, vatRate: 25 },
      { text: 'Whiteboardpennor 4-pack', qty: 1, unitPrice: 96, total: 96, vatRate: 25 },
    ],
    rounding: -0.5,
    notes: ['Kortköp Mastercard **** 8802 kl 15:03'],
    cardNote: 'MASTERCARD **** 8802',
  },
  {
    id: 'extraction-009',
    file: 'e09-manga-rader',
    difficulty: 'hard',
    probe: 'Many line items: totals must be summed correctly',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Elgrossisten Nord AB',
      org: ORG_EL,
      vat: vatOf(ORG_EL),
      address: 'Industrivägen 18, 972 54 Luleå',
      bankgiro: '9911-2233',
      plusgiro: null,
    },
    invoiceNumber: 'EG-30412',
    invoiceDate: '2026-04-03',
    dueDate: '2026-05-03',
    ocr: ocrRef('30412'),
    currency: 'SEK',
    lines: [
      { text: 'Kabel EKK 3G1,5 100 m', qty: 4, unitPrice: 1180, total: 4720, vatRate: 25 },
      { text: 'Dosor infälld 70 mm', qty: 60, unitPrice: 14.5, total: 870, vatRate: 25 },
      { text: 'Strömbrytare Elko RS', qty: 25, unitPrice: 89, total: 2225, vatRate: 25 },
      { text: 'Vägguttag 2-vägs jordat', qty: 25, unitPrice: 76, total: 1900, vatRate: 25 },
      { text: 'Automatsäkring C10', qty: 12, unitPrice: 118, total: 1416, vatRate: 25 },
      { text: 'Automatsäkring C16', qty: 12, unitPrice: 118, total: 1416, vatRate: 25 },
      { text: 'Kabelskydd 25 mm 2 m', qty: 30, unitPrice: 42, total: 1260, vatRate: 25 },
      { text: 'Frakt', qty: 1, unitPrice: 495, total: 495, vatRate: 25 },
    ],
    rounding: -0.25,
    notes: ['Leverans fritt vårt lager. 30 dagar netto.'],
  },
  {
    id: 'extraction-010',
    file: 'e10-telefoni',
    difficulty: 'core',
    probe: 'Phone bill with negative öresavrundning',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Telenordia Företag AB',
      org: ORG_TELE,
      vat: vatOf(ORG_TELE),
      address: 'Box 5040, 121 05 Stockholm',
      bankgiro: '110-4485',
      plusgiro: null,
    },
    invoiceNumber: 'T-99120044',
    invoiceDate: '2026-05-31',
    dueDate: '2026-06-30',
    ocr: ocrRef('99120044'),
    currency: 'SEK',
    lines: [
      { text: 'Mobilabonnemang Företag 5 st, juni', qty: 5, unitPrice: 379, total: 1895, vatRate: 25 },
      { text: 'Samtal utanför abonnemang maj', qty: 1, unitPrice: 148.33, total: 148.33, vatRate: 25 },
    ],
    rounding: -0.16,
    notes: ['Autogiro dras 2026-06-30.'],
  },
  {
    id: 'extraction-011',
    file: 'e11-stora-belopp',
    difficulty: 'hard',
    probe: 'Large amounts in Swedish grouped format',
    font: 'times',
    kind: 'invoice',
    supplier: {
      name: 'Byggnadsfirman Granit & Söner AB',
      org: ORG_BYGG,
      vat: vatOf(ORG_BYGG),
      address: 'Verkstadsgatan 9, 654 68 Karlstad',
      bankgiro: '5566-7788',
      plusgiro: null,
    },
    invoiceNumber: 'B-2026-077',
    invoiceDate: '2026-06-12',
    dueDate: '2026-07-12',
    ocr: ocrRef('2026077'),
    currency: 'SEK',
    lines: [
      { text: 'Ombyggnad kontorsplan 3 enligt offert 2026-14, etapp 1', qty: 1, unitPrice: 486000, total: 486000, vatRate: 25 },
      { text: 'Tillkommande el-arbeten enligt ÄTA-lista', qty: 1, unitPrice: 38400, total: 38400, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Godkänd för F-skatt. Betalningsvillkor 30 dagar.'],
  },
  {
    id: 'extraction-012',
    file: 'e12-bok-frakt',
    difficulty: 'expert',
    probe: 'Mixed 6/25 % with both bankgiro and plusgiro',
    font: 'helvetica',
    kind: 'invoice',
    supplier: {
      name: 'Facklitteratur Direkt Norden AB',
      org: ORG_BOK,
      vat: vatOf(ORG_BOK),
      address: 'Ringvägen 100, 118 60 Stockholm',
      bankgiro: '5050-6060',
      plusgiro: '12 34 56-7',
    },
    invoiceNumber: 'FD-7180',
    invoiceDate: '2026-03-25',
    dueDate: '2026-04-24',
    ocr: ocrRef('7180'),
    currency: 'SEK',
    lines: [
      { text: 'K3 i praktiken, 3 ex', qty: 3, unitPrice: 640, total: 1920, vatRate: 6 },
      { text: 'Momshandboken 2026, 2 ex', qty: 2, unitPrice: 780, total: 1560, vatRate: 6 },
      { text: 'Frakt och emballage', qty: 1, unitPrice: 120, total: 120, vatRate: 25 },
    ],
    rounding: null,
    notes: ['Betala till bankgiro eller plusgiro, ange OCR.'],
  },
]

// --- rendering -------------------------------------------------------------

async function render(spec: DocSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const fontMap = {
    helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
    times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
    courier: [StandardFonts.Courier, StandardFonts.CourierBold],
  } as const
  const font = await pdf.embedFont(fontMap[spec.font][0])
  const bold = await pdf.embedFont(fontMap[spec.font][1])
  const t = totals(spec)
  const cur = spec.currency

  let y = 790
  const draw = (
    text: string,
    x: number,
    opts: { size?: number; bold?: boolean; right?: number } = {},
  ) => {
    const f: PDFFont = opts.bold ? bold : font
    const size = opts.size ?? 10
    let drawX = x
    if (opts.right !== undefined) {
      drawX = opts.right - f.widthOfTextAtSize(text, size)
    }
    ;(page as PDFPage).drawText(text, { x: drawX, y, size, font: f, color: rgb(0.1, 0.1, 0.12) })
  }
  const nl = (dy = 14) => {
    y -= dy
  }

  const heading =
    spec.kind === 'credit_note' ? 'KREDITFAKTURA' : spec.kind === 'receipt' ? 'KVITTO' : 'FAKTURA'
  draw(spec.supplier.name, 50, { size: 15, bold: true })
  draw(heading, 545, { size: 15, bold: true, right: 545 })
  nl(16)
  draw(spec.supplier.address, 50, { size: 9 })
  nl(12)
  if (spec.supplier.org) {
    draw(`Org.nr: ${spec.supplier.org}`, 50, { size: 9 })
    nl(12)
  }
  if (spec.supplier.vat) {
    draw(`Momsreg.nr: ${spec.supplier.vat}`, 50, { size: 9 })
    nl(12)
  }
  nl(8)

  const label = spec.kind === 'receipt' ? 'Kvittonr' : 'Fakturanr'
  draw(`${label}: ${spec.invoiceNumber}`, 50, { bold: true })
  draw(`Datum: ${spec.invoiceDate}`, 545, { right: 545 })
  nl()
  if (spec.dueDate) {
    draw(`Förfallodatum: ${spec.dueDate}`, 545, { right: 545 })
  }
  if (spec.buyer) {
    draw(`Köpare: ${spec.buyer.name}${spec.buyer.vat ? `, VAT ${spec.buyer.vat}` : ''}`, 50, {
      size: 9,
    })
  }
  nl()
  if (spec.ocr) {
    draw(`OCR: ${spec.ocr}`, 50, { bold: true })
    nl()
  }
  if (spec.servicePeriod) {
    draw(`Avser period: ${spec.servicePeriod.start} - ${spec.servicePeriod.end}`, 50)
    nl()
  }
  nl(10)

  draw('Beskrivning', 50, { size: 9, bold: true })
  draw('Antal', 360, { size: 9, bold: true, right: 380 })
  draw('À-pris', 450, { size: 9, bold: true, right: 450 })
  draw(`Belopp ${cur}`, 545, { size: 9, bold: true, right: 545 })
  nl(6)
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) })
  nl(14)
  for (const line of spec.lines) {
    draw(line.text.length > 58 ? line.text.slice(0, 58) : line.text, 50, { size: 9 })
    draw(String(line.qty), 360, { size: 9, right: 380 })
    if (line.unitPrice !== null) draw(sek(line.unitPrice), 450, { size: 9, right: 450 })
    draw(sek(line.total), 545, { size: 9, right: 545 })
    nl(13)
  }
  nl(4)
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) })
  nl(16)

  draw('Summa exkl. moms', 380, { size: 9 })
  draw(sek(t.subtotal), 545, { size: 9, right: 545 })
  nl(13)
  for (const row of t.breakdown) {
    draw(`Moms ${row.rate} % på ${sek(row.base)}`, 380, { size: 9 })
    draw(sek(row.amount), 545, { size: 9, right: 545 })
    nl(13)
  }
  if (spec.lines.every((l) => l.vatRate === 0)) {
    draw('Moms 0 %', 380, { size: 9 })
    draw(sek(0), 545, { size: 9, right: 545 })
    nl(13)
  }
  if (spec.rounding !== null && spec.rounding !== 0) {
    draw('Öresavrundning', 380, { size: 9 })
    draw(sek(spec.rounding), 545, { size: 9, right: 545 })
    nl(13)
  }
  draw('ATT BETALA', 380, { size: 11, bold: true })
  draw(`${sek(t.total)} ${cur}`, 545, { size: 11, bold: true, right: 545 })
  nl(24)

  const pay: string[] = []
  if (spec.supplier.bankgiro) pay.push(`Bankgiro: ${spec.supplier.bankgiro}`)
  if (spec.supplier.plusgiro) pay.push(`Plusgiro: ${spec.supplier.plusgiro}`)
  if (pay.length > 0) {
    draw(pay.join('    '), 50, { size: 10, bold: true })
    nl()
  }
  if (spec.cardNote) {
    draw(spec.cardNote, 50, { size: 9 })
    nl()
  }
  for (const note of spec.notes) {
    draw(note.length > 95 ? note.slice(0, 95) : note, 50, { size: 8 })
    nl(11)
  }

  return pdf.save()
}

async function main() {
  const tasks: unknown[] = []
  for (const spec of DOCS) {
    const bytes = await render(spec)
    const pdfPath = path.join(DOCS_DIR, `${spec.file}.pdf`)
    fs.writeFileSync(pdfPath, bytes)
    execFileSync('pdftoppm', ['-png', '-r', '150', '-singlefile', pdfPath, pdfPath.replace(/\.pdf$/, '')])
    const t = totals(spec)
    tasks.push({
      id: spec.id,
      suite: 'extraction',
      data_class: 'public',
      difficulty: spec.difficulty,
      probe: spec.probe,
      rationale: 'Synthetic document generated by bench/scripts/generate-extraction-docs.ts; gold values come from the same constants that rendered the PDF.',
      input: { document: `${spec.file}.pdf` },
      gold: {
        documentKind: spec.kind,
        supplierName: spec.supplier.name,
        orgNumber: spec.supplier.org,
        vatNumber: spec.supplier.vat,
        bankgiro: spec.supplier.bankgiro,
        plusgiro: spec.supplier.plusgiro,
        invoiceNumber: spec.invoiceNumber,
        invoiceDate: spec.invoiceDate,
        dueDate: spec.dueDate,
        paymentReference: spec.ocr,
        currency: spec.currency,
        subtotal: t.subtotal,
        vatAmount: t.vatAmount,
        total: t.total,
        roundingAmount: spec.rounding,
        servicePeriodStart: spec.servicePeriod?.start ?? null,
        servicePeriodEnd: spec.servicePeriod?.end ?? null,
        vatBreakdown: t.breakdown,
      },
    })
  }
  fs.writeFileSync(path.join(OUT, 'docs.json'), JSON.stringify(tasks, null, 2) + '\n')
  console.log(`Rendered ${DOCS.length} documents and wrote docs.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
