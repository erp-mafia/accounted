export default {
  rule: 'tax-deadline-window-years',
  says: 'The years the tax deadline generator dates, and the nightly repair expects, are last year, this year and next: deadlineWindowYears. No caller builds the years itself.',
  home: 'src/lib/tax/deadline-generator.ts: deadlineWindowYears',
  why: 'Six places in the generator each wrote [currentYear, currentYear + 1], so every regeneration from 1 January would have deleted the pending AGI and moms deadlines of December, which fall due in January and February.',
  match: [
    // [currentYear, currentYear + 1]: a window that starts this year.
    /\[\s*(\w+)\s*,\s*\1\s*\+\s*1\s*\]/,
  ],
  scan: ['lib/tax/', 'app/api/tax-deadlines/', 'app/api/tax-assessment-notices/'],
}
