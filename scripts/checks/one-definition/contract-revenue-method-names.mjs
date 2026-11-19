export default {
  rule: 'contract-revenue-method-names',
  says: 'Each K3 method for pågående arbeten has one Swedish name: successiv vinstavräkning and färdigställandemetoden; alternativregeln is K2 and names no K3 method.',
  home: 'src/lib/bokslut/pagaende-arbeten/methods.ts: CONTRACT_REVENUE_METHOD_NAMES',
  why: 'The K3 årsredovisning note wrote its own labels: the färdigställandemetod was called "alternativregeln i K3 23.31" (K2 wording) and the choice named Färdigställandemetoden printed successiv vinstavräkning.',
  match: [
    /['"`](?:Successiv vinstavräkning|Färdigställandemetoden)\b/,
    /enligt (?:successiv vinstavräkning|färdigställandemetoden)\b/i,
    /alternativregeln i K3/i,
  ],
  sanctioned: ['lib/bokslut/pagaende-arbeten/methods.ts'],
  allowed: {
    'lib/reports/behandlingshistorik.ts':
      'The ledger kernel may not import the year-end block (lib/modules boundary); pagaende-arbeten/__tests__/methods.test.ts holds its copy to the definition.',
  },
}
