/**
 * Ställda säkerheter, eventualförpliktelser and the parent company: the
 * registers in Avtal och åtaganden write the text (lib/commitments,
 * note-text.ts), the free text on arsredovisning_narratives stays a manual
 * override. One resolution for the PDF notes and the iXBRL filing, so the
 * two cannot disagree: the manual text when one is written, else the
 * register's, else the note's "Inga.".
 */
export interface RegisterDisclosureTexts {
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company: { name: string; org_number: string | null; city: string | null } | null
}

export interface ManualDisclosureTexts {
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
}

const filled = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null)

export function effectiveDisclosureTexts(
  manual: Partial<ManualDisclosureTexts> | null | undefined,
  registers: RegisterDisclosureTexts | null | undefined,
): ManualDisclosureTexts {
  const manualParent = filled(manual?.parent_company_name)
  const registerParent = manualParent ? null : registers?.parent_company ?? null
  return {
    securities_pledged: filled(manual?.securities_pledged) ?? registers?.securities_pledged ?? null,
    contingent_liabilities: filled(manual?.contingent_liabilities) ?? registers?.contingent_liabilities ?? null,
    parent_company_name: manualParent ?? registerParent?.name ?? null,
    parent_company_org_number: manualParent ? manual?.parent_company_org_number ?? null : registerParent?.org_number ?? null,
    parent_company_city: manualParent ? manual?.parent_company_city ?? null : registerParent?.city ?? null,
  }
}

/** A manual text that differs from what the register says: the person should know which one the document carries. */
export function registerOverrideWarnings(
  manual: Partial<ManualDisclosureTexts> | null | undefined,
  registers: RegisterDisclosureTexts | null | undefined,
): string[] {
  if (!registers) return []
  const warnings: string[] = []
  const differs = (a: string | null, b: string | null) => a != null && b != null && a !== b
  if (differs(filled(manual?.securities_pledged), registers.securities_pledged)) {
    warnings.push('Ställda säkerheter: den manuella texten används i stället för registret i Avtal och åtaganden. Töm fältet för att använda registret.')
  }
  if (differs(filled(manual?.contingent_liabilities), registers.contingent_liabilities)) {
    warnings.push('Eventualförpliktelser: den manuella texten används i stället för registret i Avtal och åtaganden. Töm fältet för att använda registret.')
  }
  if (differs(filled(manual?.parent_company_name), registers.parent_company?.name ?? null)) {
    warnings.push('Moderföretag: det manuellt angivna moderföretaget används i stället för koncernregistret i Avtal och åtaganden.')
  }
  return warnings
}
