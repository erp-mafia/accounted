export default {
  rule: 'due-date-itself-is-on-time',
  says: 'An invoice is past due only from the Swedish day after its due date.',
  home: 'src/lib/dates/iso.ts: isPastDue',
  why: 'new Date(due) < new Date() made an invoice overdue on its own due date, from midnight UTC; a storno or an uncredit then wrote that status',
  match: [
    /new Date\([\w.?]*due_?[dD]ate\w*\)\s*<=?\s*(?:new Date\(\s*\)|now\b|Date\.now\(\))/,
    /\bdue(?:_?[dD]ate)?\s*<=?\s*(?:[\w.]+\.)?today(?:Iso|Str)?\b/,
    /\b(?:[\w.]+\.)?today\w*\s*[<>]=?\s*[\w.]*\bdue(?:_?[dD]ate)?\b/,
  ],
  sanctioned: ['lib/dates/iso.ts'],
  allowed: {
    'lib/tax/deadline-generator.ts': 'keeps rows due from today on inside a window: a window, not the past-due test',
    'lib/forecast/adapters/tax.ts': 'moves a late tax payment onto today: where a cash flow lands, not whether it is late',
  },
}
