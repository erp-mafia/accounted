export default {
  rule: 'correction-path-applies',
  says: 'Which correction paths a posted verifikat offers (inline rättelse only in an open, unlocked period, first; past a lock, a close or the lock date only the ändringsverifikat moved to the first open period) is asked of correctionPaths, and the entry types whose lines are never struck inline are its LINE_RATTELSE_EXCLUDED_SOURCES.',
  home: 'src/lib/core/bookkeeping/correction-paths.ts: correctionPaths',
  why: 'The verifikat page listed five paths past a lock where the server books one, and the verifikat list offered only the storno paths in an open period, each door with its own list of entry types.',
  match: [
    // ['storno', 'year_end', 'vat_settlement'] (with or without
    // 'opening_balance'): the entry types inline rättelse refuses, written by
    // hand beside a door that decides which correction to offer.
    /\[\s*'storno',\s*(?:'opening_balance',\s*)?'year_end',\s*'vat_settlement'\s*\]/,
  ],
  sanctioned: ['lib/core/bookkeeping/correction-paths.ts'],
}
