export default {
  rule: 'register-update-writes-stated',
  says: 'A customer or supplier import that updates a matched record writes what the row states, never the fill-ins its parser makes for a new record: the type and country by typeAndCountryForUpdate (a word for any company keeps a company\'s own kind), a supplier\'s currency only when the file gives one.',
  home: 'src/lib/import/shared/stated-fields.ts: typeAndCountryForUpdate, updateWritesType, statedType',
  why: 'Each import merged the parser\'s fill-ins because they are always set, so a file without a type, country or currency column made an EU customer or supplier a Swedish business in SE (and a supplier\'s currency SEK); the customer import was fixed first and the supplier import kept the copy.',
  match: [
    // A merge that writes a filled-in value because it is always set.
    /if \(row\.(customer_type|supplier_type|country|default_currency)\)/,
    // The type decision or its reading written by hand.
    /_type_stated\s*===\s*'business'/,
    /_type_stated:\s*[^,]*\?\s*'business'/,
  ],
  sanctioned: ['lib/import/shared/stated-fields.ts'],
  scan: ['app/api/import/', 'lib/import/'],
}
