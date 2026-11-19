export default {
  rule: 'ledger-as-of-date-check',
  says: 'Every door of the two reskontra checks the balance date with parseLedgerAsOfDate before aging against it.',
  home: 'src/lib/reports/ledger-as-of.ts: parseLedgerAsOfDate',
  why: 'The dashboard JSON and xlsx doors had no check and the PDF doors a shape regex, so as_of_date=garbage aged a not-yet-due invoice into 90+ and 2026-02-31 passed.',
  match: [/(?<!parseLedgerAsOfDate\((?:url\.)?)searchParams\.get\('as_of_date'\)/],
  scan: [
    'app/api/reports/ar-ledger/',
    'app/api/reports/supplier-ledger/',
    'app/api/v1/companies/[companyId]/reports/ar-ledger/',
    'app/api/v1/companies/[companyId]/reports/supplier-ledger/',
  ],
}
