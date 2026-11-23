/**
 * Reading ISO 20022 XML (camt.053 statements, camt.054 notifications) with no
 * XML dependency: the lookups the parsers need, by element name.
 *
 * The readers are textual. An element is found by its exact name and its
 * first closing tag, so a name that nests inside itself (<Id> inside <Id>)
 * is never asked for directly: ask for the unambiguous parent first
 * (<Othr>, <OrgId>) and read the child inside it.
 */
import { bankBookingDay } from '@/lib/dates/iso'

/**
 * Drop namespace prefixes from element names (<ns2:Ntry> becomes <Ntry>,
 * </ns2:Ntry> becomes </Ntry>). Attributes such as xmlns:ns2 are left alone;
 * nothing reads them.
 */
export function stripNamespacePrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, '<$1')
}

/** Drop XML comments, so a commented-out element is never read as one. */
export function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '')
}

const NAMED_XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The five predefined XML entities plus numeric character references. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    const codePoint = lower.startsWith('#x')
      ? parseInt(lower.slice(2), 16)
      : lower.startsWith('#')
        ? parseInt(lower.slice(1), 10)
        : null
    if (codePoint === null) return NAMED_XML_ENTITIES[lower] ?? match
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
  })
}

/**
 * Extract all occurrences of a named XML element (simple parser, no dependencies)
 */
export function extractElements(xml: string, tagName: string): string[] {
  const elements: string[] = []
  // Match exact tag name (followed by > or whitespace, not a longer tag name)
  const regex = new RegExp(`<${tagName}(?=[\\s>/])`, 'gi')
  let match

  while ((match = regex.exec(xml)) !== null) {
    const startIdx = match.index
    // Find matching closing tag
    const closeTag = `</${tagName}>`
    const closeIdx = xml.indexOf(closeTag, startIdx + match[0].length)

    if (closeIdx === -1) continue

    elements.push(xml.substring(startIdx, closeIdx + closeTag.length))

    // Advance regex past this element to avoid re-matching inside it
    regex.lastIndex = closeIdx + closeTag.length
  }

  return elements
}

/**
 * Extract text content of the first occurrence of a tag. The name matches
 * exactly: <Dt> never reads <DtTm>, <Cdtr> never reads <CdtrAcct>.
 */
export function extractTextContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([^<]+)<`, 'i')
  const match = xml.match(regex)
  const text = match?.[1]?.trim()
  return text ? decodeXmlEntities(text) : null
}

/** The text content of every occurrence of a tag, in document order; blank ones are left out. */
export function extractAllText(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([^<]+)<`, 'gi')
  const out: string[] = []
  for (const match of xml.matchAll(regex)) {
    const text = match[1]?.trim()
    if (text) out.push(decodeXmlEntities(text))
  }
  return out
}

/**
 * Extract text content of a nested tag within a parent tag
 */
export function extractNestedText(xml: string, parentTag: string, childTag: string): string | null {
  const parentRegex = new RegExp(`<${parentTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${parentTag}>`, 'i')
  const parentMatch = xml.match(parentRegex)
  if (!parentMatch) return null

  return extractTextContent(parentMatch[1], childTag)
}

/** An amount element as written: the xs:decimal text and its Ccy attribute. */
export interface XmlAmount {
  value: string
  currency: string | null
}

/**
 * The first occurrence of an amount element (<Amt Ccy="SEK">1234.56</Amt>;
 * `tagName` for its named siblings, <RmtdAmt> or <CdtNoteAmt>). The name
 * matches exactly: <Amt> never reads <RmtdAmt>.
 */
export function extractAmount(xml: string, tagName = 'Amt'): XmlAmount | null {
  const match = xml.match(new RegExp(`<${tagName}(\\s[^>]*)?>([^<]+)</${tagName}>`, 'i'))
  const value = match?.[2]?.trim()
  if (!value) return null
  const currency = match?.[1]?.match(/Ccy=["']([^"']+)["']/i)?.[1] ?? null
  return { value, currency: currency ? currency.toUpperCase() : null }
}

/**
 * The calendar date of <BookgDt> or <ValDt>: an ISODate in <Dt>, or the
 * ISODateTime in <DtTm>, as the Swedish day (bankBookingDay). A local time is
 * read as written; a time with an offset is the day it fell on in Stockholm.
 */
export function extractEntryDate(entry: string, parentTag: string): string | null {
  return bankBookingDay(extractNestedText(entry, parentTag, 'Dt') || extractNestedText(entry, parentTag, 'DtTm'))
}
