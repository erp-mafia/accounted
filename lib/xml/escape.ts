/**
 * Escape a string for use as XML text or attribute content. Used by every
 * XML-emitting generator (AGI, KU10, pain.001, Peppol BIS, ROT/RUT). The
 * replace order matters: `&` first, so the entities it produces are not
 * re-escaped.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
