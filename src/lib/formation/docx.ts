/**
 * Renders a FormationDocument as a .docx (Office Open XML) file with no
 * dependency: a few XML parts in a zip written with the "stored" method
 * (no compression), which Word, Pages and LibreOffice all read.
 * The founders edit these files (a bolagsordning, an aktieägaravtal), so
 * the markup stays plain: paragraphs, runs, one simple table style. The
 * zip is the repository's own stored-entry writer (`lib/reports/zip-writer`).
 */

import { writeZip } from '@/lib/reports/zip-writer'
import type { DocBlock, FormationDocument } from './document-model'

const FONT = 'Arial'
const BODY_SIZE = 21 // half-points: 10.5 pt
const HEADING_SIZE = 24
const TITLE_SIZE = 32

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function run(text: string, opts: { bold?: boolean; size?: number; color?: string } = {}): string {
  const props = [
    `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`,
    opts.bold ? '<w:b/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    `<w:sz w:val="${opts.size ?? BODY_SIZE}"/>`,
  ].join('')
  // Line breaks inside one paragraph become <w:br/>.
  const parts = text.split('\n').map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`)
  return `<w:r><w:rPr>${props}</w:rPr>${parts.join('<w:br/>')}</w:r>`
}

function para(inner: string, opts: { spacingAfter?: number; spacingBefore?: number; indent?: number; keepNext?: boolean } = {}): string {
  const ppr = [
    opts.keepNext ? '<w:keepNext/>' : '',
    `<w:spacing w:before="${opts.spacingBefore ?? 0}" w:after="${opts.spacingAfter ?? 120}" w:line="276" w:lineRule="auto"/>`,
    opts.indent ? `<w:ind w:left="${opts.indent}" w:hanging="280"/>` : '',
  ].join('')
  return `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`
}

function cell(text: string, widthTwips: number, bold = false): string {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/></w:tcPr>` +
    para(run(text, { bold }), { spacingAfter: 40, spacingBefore: 40 }) +
    '</w:tc>'
  )
}

/** Twips per centimetre (1 inch = 1440 twips = 2.54 cm). */
const TWIPS_PER_CM = 1440 / 2.54
const MARGIN_Y = Math.round(2.5 * TWIPS_PER_CM)
const MARGIN_X = Math.round(2.54 * TWIPS_PER_CM)
const HEADER_GAP = Math.round(1.25 * TWIPS_PER_CM)
/** A4 width (21 cm) minus the side margins. */
const CONTENT_WIDTH = Math.round(21 * TWIPS_PER_CM) - 2 * MARGIN_X

function table(head: string[], rows: string[][], widths?: number[]): string {
  const cols = head.length
  const fractions = widths && widths.length === cols ? widths : Array.from({ length: cols }, () => 1)
  const total = fractions.reduce((a, b) => a + b, 0)
  const tw = fractions.map((f) => Math.floor((f / total) * CONTENT_WIDTH))
  const border = '<w:top w:val="single" w:sz="4" w:color="BFBAB2"/><w:bottom w:val="single" w:sz="4" w:color="BFBAB2"/><w:insideH w:val="single" w:sz="4" w:color="DDD8D0"/>'
  const grid = tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')
  const headRow = `<w:tr>${head.map((h, i) => cell(h, tw[i], true)).join('')}</w:tr>`
  const bodyRows = rows.map((r) => `<w:tr>${r.map((c, i) => cell(c, tw[i])).join('')}</w:tr>`).join('')
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_WIDTH}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders>` +
    `<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headRow}${bodyRows}</w:tbl>` +
    para('', { spacingAfter: 120 })
  )
}

function block(b: DocBlock): string {
  switch (b.kind) {
    case 'heading':
      return para(run(b.text, { bold: true, size: HEADING_SIZE }), { spacingBefore: 240, spacingAfter: 80, keepNext: true })
    case 'paragraph':
      return para(run(b.text, { bold: b.bold, color: b.muted ? '6B655C' : undefined }))
    case 'list':
      return b.items
        .map((item, i) => para(run(`${b.ordered ? `${i + 1}.` : '•'}\t${item}`), { indent: 560, spacingAfter: 60 }))
        .join('')
    case 'table':
      return table(b.head, b.rows, b.widths)
    case 'fields':
      return table(['', ''], b.rows.map((r) => [r.label, r.value]), [2, 3]).replace(/<w:tr>.*?<\/w:tr>/, '')
    case 'signatures':
      return b.people
        .map(
          (p) =>
            para('', { spacingBefore: 480, spacingAfter: 0 }) +
            para(run('_________________________________________'), { spacingAfter: 0 }) +
            para(run(p.name, { bold: true }), { spacingAfter: 0 }) +
            (p.caption ? para(run(p.caption, { color: '6B655C' }), { spacingAfter: 120 }) : ''),
        )
        .join('')
  }
}

export function documentXml(doc: FormationDocument): string {
  const body = [
    para(run(doc.title, { bold: true, size: TITLE_SIZE }), { spacingAfter: doc.subtitle ? 60 : 240 }),
    doc.subtitle ? para(run(doc.subtitle, { color: '6B655C' }), { spacingAfter: 240 }) : '',
    ...doc.blocks.map(block),
  ].join('')
  const footerRef = doc.footer ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : ''
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}<w:sectPr>${footerRef}<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="${MARGIN_Y}" w:right="${MARGIN_X}" w:bottom="${MARGIN_Y}" w:left="${MARGIN_X}" w:header="${HEADER_GAP}" w:footer="${HEADER_GAP}" w:gutter="0"/>` +
    '</w:sectPr></w:body></w:document>'
  )
}

function footerXml(text: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    para(run(text, { size: 16, color: '6B655C' }), { spacingAfter: 0 }) +
    '</w:ftr>'
  )
}

const CONTENT_TYPES = (withFooter: boolean) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  (withFooter
    ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    : '') +
  '</Types>'

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const DOCUMENT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  '</Relationships>'

/** A fixed timestamp keeps the same answers producing the same bytes. */
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1))

export async function renderDocx(doc: FormationDocument): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder()
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES(Boolean(doc.footer))) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
    { name: 'word/document.xml', data: enc.encode(documentXml(doc)) },
  ]
  if (doc.footer) {
    files.push({ name: 'word/_rels/document.xml.rels', data: enc.encode(DOCUMENT_RELS) })
    files.push({ name: 'word/footer1.xml', data: enc.encode(footerXml(doc.footer)) })
  }
  const parts: Uint8Array[] = []
  for await (const chunk of writeZip(files, { date: ZIP_DATE })) parts.push(chunk)
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
