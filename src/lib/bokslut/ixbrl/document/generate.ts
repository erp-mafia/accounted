/**
 * One door to the iXBRL document: the entry point the input was built for
 * decides the generator (K2 AB risbs or K3 AB risbs). Every caller (file
 * downloads, preflight dry run, the Bolagsverket submission) goes through
 * here, so a K3 input can never be rendered with the K2 concepts.
 */

import { getEntryPoint } from '../taxonomy/entry-points'
import type { IxbrlArsredovisningInput } from '../types'
import { generateK2IxbrlDocument } from './k2-document'
import { generateK3IxbrlDocument } from './k3-document'
import type { GeneratedIxbrl } from './layout'

export { embedKontrollsumma, type GeneratedIxbrl } from './layout'

export function generateIxbrlDocument(input: IxbrlArsredovisningInput): GeneratedIxbrl {
  return getEntryPoint(input.entryPointId).regelverk === 'K3'
    ? generateK3IxbrlDocument(input)
    : generateK2IxbrlDocument(input)
}
