export default {
  rule: 'domestic-sale-label-veto',
  says: 'A label saying a class 3 account is no domestic taxable sale vetoes a Swedish rate the same way in the import suggestion and in the declaration.',
  home: 'src/lib/vat/account-vat-treatment.ts: NOT_DOMESTIC_SALE',
  why: 'Two word lists, each said to mirror the other, each missing words the other had: "undantag" stayed out of ruta 05 on import and went into it on the declaration.',
  match: [/momsfri\|.*(?:omvänd|vinstmarginal)/],
  sanctioned: ['lib/vat/account-vat-treatment.ts'],
}
