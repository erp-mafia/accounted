/**
 * Warnings buildIxbrlInput raises about facts that only arrive after a
 * version is locked: the signatures and the årsstämma. A locked version
 * freezes its warnings with its content, so once those facts are put on top
 * (version-ixbrl.ts) the matching warnings go too; otherwise the validation
 * of a fully signed report still says it is unsigned.
 */
export const NO_SIGNERS_WARNING =
  'Inga underskrifter är registrerade: årsredovisningen måste skrivas under av styrelsen (och ev. VD) innan inlämning (kontrollera-kod 1107/1201).'
export const NOT_ALL_SIGNED_WARNING = 'Alla underskriftsförfrågningar är inte signerade ännu.'
export const AGM_DATE_MISSING_WARNING =
  'Datum för årsstämma saknas: fastställelseintyget kan inte fyllas i (kontrollera-kod 1103).'
export const AGM_DECISION_MISSING_WARNING =
  'Årsstämmans beslut om resultatdisposition saknas i fastställelseintyget.'

/** The PDF model's own notice about a missing AGM date (build-data.ts), carried into the input. */
const PDF_AGM_DATE_MISSING = /^Datum för (årsstämma|föreningsstämma) saknas\. /

export function withoutSignatureWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => warning !== NO_SIGNERS_WARNING && warning !== NOT_ALL_SIGNED_WARNING)
}

export function withoutAgmWarnings(
  warnings: string[],
  resolved: { date: boolean; decision: boolean },
): string[] {
  return warnings.filter((warning) => {
    if (resolved.date && (warning === AGM_DATE_MISSING_WARNING || PDF_AGM_DATE_MISSING.test(warning))) return false
    if (resolved.decision && warning === AGM_DECISION_MISSING_WARNING) return false
    return true
  })
}
