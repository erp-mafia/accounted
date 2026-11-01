export default {
  rule: 'provider-refusal-reading',
  says: 'A provider refusal is read by one classifier, so every door agrees on dead token, closed register, missing licence and inactive module.',
  home: 'src/lib/providers/with-provider-call.ts: classifyProviderError, isProviderRefusal',
  why: 'Doors read 401 and 403 by hand: a Fortnox refusal under a 400 kept a pass calling per invoice and retried hourly, and a Visma module refusal asked the customer to reconnect for ever.',
  match: [/\bstatus(?:Code)?\s*===\s*401\s*\|\|\s*(?:\w+\.)*status(?:Code)?\s*===\s*403\b(?!\s*\|\|)/],
  sanctioned: ['lib/providers/with-provider-call.ts'],
  allowed: {
    'extensions/general/arcim-migration/lib/provider-client.ts': 'The token probe asks a different question: did Bokio accept what was pasted. It reads the plan refusal through isBokioPricePlanError.',
    'extensions/general/arcim-migration/lib/import-documents.ts': 'A Bokio token cannot be refreshed, so both statuses end the sweep at once; a 401 and a 403 name different remedies on the connection card.',
  },
  scan: ['extensions/general/arcim-migration/', 'lib/providers/'],
}
