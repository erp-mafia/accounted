/**
 * What the assistant's core knowledge areas are called on a page a person
 * reads. The atoms carry English titles and developer-facing descriptions
 * (they are skills first); these are the Swedish names the Kompetens view
 * and the competence chips show instead. Unknown ids fall back to the
 * atom's own title.
 */
const ATOM_LABEL_SV: Record<string, string> = {
  'swedish-accounting-compliance': 'Bokföringslagen och god redovisningssed',
  'swedish-vat': 'Moms',
  'swedish-payroll': 'Lön och arbetsgivaravgifter',
  'swedish-invoice-compliance': 'Fakturakrav',
  'swedish-e-invoicing': 'E-faktura och Peppol',
  'swedish-financial-reporting': 'Årsredovisning (K2 och K3)',
  'swedish-asset-accounting': 'Anläggningstillgångar och avskrivningar',
  'swedish-project-accounting': 'Projektredovisning',
  'swedish-sie-import-export': 'SIE-filer',
  'swedish-sru-filing': 'Inkomstdeklaration (SRU)',
  'swedish-tax-planning': 'Skatteplanering för bolag',
  'swedish-year-end-closing': 'Bokslut',
}

export function atomLabel(atom: { id: string; title: string }): string {
  return ATOM_LABEL_SV[atom.id] ?? atom.title
}
