/**
 * Structural checks of a generated BLANKETTER.SRU, used by the INK2 and NE
 * generator tests. They live here, not in the generators, because nothing in
 * the product calls them: the generators are pinned by these checks instead.
 */

export interface SruValidation {
  isValid: boolean
  errors: string[]
}

/** INK2: the INK2, INK2R and INK2S blocks, each with #IDENTITET and #NAMN. */
export function validateInk2BlanketterSru(content: string): SruValidation {
  const errors: string[] = []

  if (!/^#BLANKETT INK2-/m.test(content)) errors.push('Missing INK2 blankett block')
  if (!/^#BLANKETT INK2R-/m.test(content)) errors.push('Missing INK2R blankett block')
  if (!/^#BLANKETT INK2S-/m.test(content)) errors.push('Missing INK2S blankett block')
  if (!/^#FIL_SLUT/m.test(content)) errors.push('Missing #FIL_SLUT terminator')

  const blankettslutCount = (content.match(/^#BLANKETTSLUT/gm) || []).length
  if (blankettslutCount !== 3) {
    errors.push(`Expected 3 BLANKETTSLUT, found ${blankettslutCount}`)
  }

  const blankettBlocks = content.split(/^#BLANKETT /m).slice(1)
  for (const block of blankettBlocks) {
    const type = block.split('\n')[0]?.split('\r')[0] || 'unknown'
    if (!block.includes('#IDENTITET')) errors.push(`Blankett ${type} missing #IDENTITET`)
    if (!block.includes('#NAMN')) errors.push(`Blankett ${type} missing #NAMN`)
  }

  return { isValid: errors.length === 0, errors }
}

/**
 * NE: one NE block with identity, name and räkenskapsårets datum (fields 7011
 * and 7012; their absence is a level-2 rejection at Skatteverket).
 */
export function validateNeBlanketterSru(content: string): SruValidation {
  const errors: string[] = []

  if (!/^#BLANKETT NE-/m.test(content)) errors.push('Missing #BLANKETT NE- block')
  if (!/^#IDENTITET /m.test(content)) errors.push('Missing #IDENTITET')
  if (!/^#NAMN /m.test(content)) errors.push('Missing #NAMN')
  if (!/^#UPPGIFT 7011 /m.test(content)) errors.push('Missing #UPPGIFT 7011 (räkenskapsårets början)')
  if (!/^#UPPGIFT 7012 /m.test(content)) errors.push('Missing #UPPGIFT 7012 (räkenskapsårets slut)')
  if (!/^#FIL_SLUT/m.test(content)) errors.push('Missing #FIL_SLUT terminator')

  const blankettslutCount = (content.match(/^#BLANKETTSLUT/gm) || []).length
  if (blankettslutCount !== 1) {
    errors.push(`Expected 1 #BLANKETTSLUT, found ${blankettslutCount}`)
  }

  return { isValid: errors.length === 0, errors }
}
