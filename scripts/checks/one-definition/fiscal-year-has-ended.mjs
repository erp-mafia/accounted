export default {
  rule: 'fiscal-year-has-ended',
  says: 'A year or period has ended only when its last day has passed in Sweden.',
  home: 'src/lib/dates/iso.ts: hasEnded',
  why: 'Year-end and klarmarkera took the last day as ended while the iXBRL, VAT and onboarding doors did not.',
  match: [
    /^(?!.*(?:period_start|\.start\b)).*\b(?:period_end|periodEnd|(?:period|fy|year)\.end)\s*(?:<=?|>=?)\s*(?:today\w*\b|todayIsoStockholm\(\))/,
    /^(?!.*(?:period_start|\.start\b)).*\b(?:today\w*\b|todayIsoStockholm\(\))\s*(?:<=?|>=?)\s*\w*\.?(?:period_end|periodEnd|(?:period|fy|year)\.end)\b/,
    /\.(?:lte|gt)\('period_end',\s*(?:today\w*\b|todayIsoStockholm\(\))/,
  ],
  sanctioned: ['lib/dates/iso.ts'],
  allowed: {
    'app/api/reports/vacation-liability/route.ts': 'Clamps an as-of date to today; whether the period has ended decides nothing.',
  },
}
