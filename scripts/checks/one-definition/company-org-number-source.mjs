export default {
  rule: 'company-org-number-source',
  says: 'The company\'s own org number is read through one reader that decides which stored copy counts and what an empty copy means.',
  home: 'src/lib/company/org-number.ts: effectiveOrgNumber, readCompanyOrgNumber, companyOrgNumber',
  why: 'Eighteen readers picked between company_settings and companies each their own way: a company can hold the number in settings only, and KU31 refused it while a salary file wrote the word undefined into its message id.',
  match: [
    /\b(settings|company)\w*\??\.org_number\b[^,;]*(\|\||\?\?)[^,;]*\b(settings|company)\w*\??\.org_number\b/i,
  ],
  sanctioned: ['lib/company/org-number.ts'],
}
