export default {
  rule: 'sie-import-in-place',
  says: 'An SIE import is in place when its status is completed and it has no job or a completed import job; a reader asks whereSieImportInPlace.',
  home: 'src/lib/bookkeeping/sie-import-in-place.ts: whereSieImportInPlace',
  why: 'Seventeen readers gated on status completed alone, which also holds while a durable import is being undone and for a stopped duplicate repair, so an import on its way out of the ledger still read as the year\'s import.',
  match: [/\.eq\('status',\s*'completed'\)/],
  sanctioned: ['lib/bookkeeping/sie-import-in-place.ts'],
  allowed: {
    'lib/signing/seal.ts': 'a signing request\'s status, not an SIE import.',
    'lib/signing/verify.ts': 'a signing request\'s status, not an SIE import.',
  },
}
