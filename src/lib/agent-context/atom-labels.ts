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

/** The same names keyed by the atoms' English titles, for ids in another shape than the skill folders. */
const ATOM_LABEL_BY_TITLE: Record<string, string> = {
  'Swedish Accounting Compliance': ATOM_LABEL_SV['swedish-accounting-compliance'],
  'Swedish VAT': ATOM_LABEL_SV['swedish-vat'],
  'Swedish Payroll': ATOM_LABEL_SV['swedish-payroll'],
  'Swedish Invoice Compliance': ATOM_LABEL_SV['swedish-invoice-compliance'],
  'Swedish E Invoicing': ATOM_LABEL_SV['swedish-e-invoicing'],
  'Swedish Financial Reporting': ATOM_LABEL_SV['swedish-financial-reporting'],
  'Swedish Asset Accounting': ATOM_LABEL_SV['swedish-asset-accounting'],
  'Swedish Project Accounting': ATOM_LABEL_SV['swedish-project-accounting'],
  'Swedish SIE Import Export': ATOM_LABEL_SV['swedish-sie-import-export'],
  'Swedish SRU Filing': ATOM_LABEL_SV['swedish-sru-filing'],
  'Swedish Tax Planning': ATOM_LABEL_SV['swedish-tax-planning'],
  'Swedish Year End Closing': ATOM_LABEL_SV['swedish-year-end-closing'],
}

export function atomLabel(atom: { id: string; title: string }): string {
  const byId = ATOM_LABEL_SV[atom.id] ?? ATOM_LABEL_SV[atom.id.replace(/_/g, '-')]
  return byId ?? ATOM_LABEL_BY_TITLE[atom.title.trim()] ?? atom.title
}
