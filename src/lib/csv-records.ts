/**
 * Splitting delimited text (CSV, semicolon or tab separated) into records.
 * Shared infrastructure: the chart-of-accounts import and the Kustom
 * settlement report read their files through it, so there is one splitter
 * with one answer to quoted delimiters, quoted line breaks and a file that
 * stops mid-field.
 */

/**
 * Split the whole file into records, honouring double-quoted fields.
 *
 * Deliberately small rather than a dependency: the only quoting these formats
 * use is a field wrapped in double quotes, with a doubled quote for a literal
 * one. Account names carrying a semicolon are the case that makes a plain
 * split wrong.
 *
 * Records, not lines. Splitting the text on newlines first and parsing quotes
 * afterwards honours a quoted delimiter but not a quoted line break, which is
 * half a guarantee: the same field that may hold a semicolon may hold a CR or
 * LF, and a parser that handles one and silently tears the other apart is
 * harder to diagnose than one that handles neither. CR, LF and CRLF all end a
 * record outside quotes and are all kept verbatim inside them.
 */
export function splitCsvRecords(
  text: string,
  delimiter: string,
): { records: string[][]; unterminated: boolean } {
  const records: string[][] = []
  let fields: string[] = []
  let field = ''
  let inQuotes = false

  const endField = () => { fields.push(field); field = '' }
  const endRecord = () => {
    endField()
    // A trailing newline must not manufacture an empty record, and neither
    // must a blank line between rows.
    if (fields.some((f) => f.trim() !== '')) records.push(fields)
    fields = []
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char !== '"') {
        field += char
      } else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = false
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      endField()
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      endRecord()
      continue
    }
    field += char
  }
  if (field !== '' || fields.length > 0) endRecord()
  // Still inside a quote at EOF means the file stops mid-field: a download that
  // was cut, not a finished file. The rows before the cut parse perfectly well, which is
  // the danger, so the fact has to leave this function rather than being
  // rounded off into a last record that looks like every other one.
  return { records, unterminated: inQuotes }
}
