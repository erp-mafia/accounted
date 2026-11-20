/**
 * The two letters on the company's tile in the sidebar: the first letters of
 * its first two words, or the first two letters of a one-word name.
 */
export function companyInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)
  return letters.toUpperCase() || '?'
}
