export default {
  rule: 'statement-row-list',
  says: 'The årsredovisning PDF and the iXBRL print one row list per framework: the same posts, labels and order, the same posts hidden.',
  home: 'src/lib/bokslut/ixbrl/document/statements.ts: printedRows',
  why: 'The PDF kept a hand-written list next to the filing\'s, so a K3 report kept the K2 order and four K2 labels: the promise that the two cannot diverge held for K2 only.',
  match: [/\bnew RowBuilder\(/, /label:\s*'(?:Summa omsättningstillgångar|Summa eget kapital och skulder)'/],
  scan: ['lib/bokslut/arsredovisning/'],
}
