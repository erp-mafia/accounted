/**
 * Numeric-aware ordering for the customer register's Kundnr column.
 *
 * `customers.customer_number` is a free-text identifier ('2', '10', 'K-1001'),
 * so a plain string compare puts '10' before '2' and the column reads as
 * scrambled to anyone who numbers their customers. Same rule as the article
 * register (lib/articles/sort.ts): collate numerically, and put customers
 * without a number last in ascending order, since the column exists to read
 * the numbered ones.
 */

const numberCollator = new Intl.Collator('sv', { numeric: true, sensitivity: 'base' })

export function compareCustomerNumbers(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const aNum = a?.trim()
  const bNum = b?.trim()
  if (aNum && bNum) return numberCollator.compare(aNum, bNum)
  if (aNum) return -1
  if (bNum) return 1
  return 0
}
