export default {
  rule: 'auto-learned-mapping-rule',
  says: "Which mapping rows are auto-learned, and whether a company's are written and read, is answered by one module on every door that writes or reads mapping_rules.",
  home: 'src/lib/bookkeeping/mapping-engine.ts: isAutoLearnedMappingRule, readsAutoLearnedMappingRules, mappingRulesRead',
  why: 'Three readers and one writer share the table: a reader that filtered on the source by hand, or a writer that did not ask, would propose from rows the others had stopped reading.',
  match: [
    // The source compared or filtered on by hand.
    /\.source\s*[!=]==?\s*'auto'/,
    /\(\s*'source'\s*,\s*'auto'\s*\)/,
    /source:\s*'auto'\s*[,}]/,
  ],
  sanctioned: ['lib/bookkeeping/mapping-engine.ts'],
}
