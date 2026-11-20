export default {
  rule: 'import-org-number-key',
  says: 'Two org numbers are one number when sameOrgNumber says so, and a wrong-company check compares through one door.',
  home: 'src/lib/company/org-number.ts: compareSourceOrgNumber',
  why: 'The skattekonto file compared digits against settings alone, so the same number in 12 digits read as another company, and a company with its number only on the company row was never checked.',
  match: [
    /\b(company|file|provider|source|target)\w*Org\w*\s*!==\s*(company|file|provider|source|target)\w*Org\w*\b/,
    /normalizeOrgNumber\([^)]*\)\s*===\s*normalizeOrgNumber\(/,
  ],
  sanctioned: ['lib/invariants/org-number.ts', 'lib/company/org-number.ts'],
}
