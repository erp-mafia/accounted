export default {
  rule: 'bank-file-amount-parser',
  says: 'Every file importer reads an amount with parseSwedishAmount, given the decimal mark of the file, so a cell never loses kronor or öre silently.',
  home: 'src/lib/money.ts: parseSwedishAmount',
  why: 'parseFloat stops at the first character it does not know: Swedbank read 1,234.56 as 1 and generic CSV read -1.234,56 as -1.234, with no issue on the row.',
  match: [/\bparseFloat\(/],
  scan: ['lib/import/bank-file/', 'components/import/BankFileColumnMappingStep.tsx'],
}
