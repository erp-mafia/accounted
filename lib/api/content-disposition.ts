/**
 * RFC 6266 Content-Disposition builder with RFC 5987 extended filename
 * encoding.
 *
 * undici (the fetch/Headers implementation in the Next.js runtime) requires
 * header values to be ByteStrings: every code unit <= 0xFF. Splicing a raw
 * filename into the header therefore throws for any non-Latin-1 character,
 * e.g. the NFD combining diaeresis (U+0308) that macOS/iOS uploads put in
 * Swedish filenames, turning the whole response into a 500.
 *
 * The dual form emitted here is:
 *
 *   <type>; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>
 *
 * Legacy clients read `filename`; modern browsers prefer `filename*`
 * (RFC 6266 section 4.3) and decode the original UTF-8 name.
 */
export function contentDisposition(
  type: 'inline' | 'attachment',
  filename: string,
): string {
  // Lone/unpaired UTF-16 surrogates survive normalize('NFC') and make
  // encodeURIComponent below throw a URIError, which would turn the download
  // response into the very 500 this helper exists to prevent. Replace them
  // with U+FFFD first so the function always returns a valid header value.
  // Then normalize NFD (macOS/iOS) to NFC so precomposed characters encode
  // as themselves instead of base letter + combining mark.
  const normalized = filename.toWellFormed().normalize('NFC')

  // ASCII fallback for the quoted-string form: anything outside printable
  // ASCII, plus the quoted-string specials " and \, becomes _. This also
  // neutralizes CR/LF header injection.
  const fallback = normalized.replace(/[^\x20-\x7e]|["\\]/g, '_')

  // RFC 5987 value-chars: encodeURIComponent covers everything except
  // ! ' ( ) * which it leaves bare but RFC 5987 forbids unencoded.
  const encoded = encodeURIComponent(normalized).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
