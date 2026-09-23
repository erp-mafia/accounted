/**
 * The accepted SIE extensions used to live as a separate literal in every
 * surface that checked them: a regex in the parse route, an `endsWith` chain
 * in the upload component, another in the MCP upload tool, plus the sentences
 * that describe them. They drifted, which is what #2546 reported: `.si` was
 * accepted by MCP but rejected by the dashboard, and even once the route
 * learned `.si` the rejection message still named only two extensions. These
 * tests pin the one list and every sentence describing it to each other, so
 * the next extension added to the array cannot leave a string behind.
 */
import { describe, it, expect } from 'vitest'
import {
  SIE_FILE_EXTENSIONS,
  SIE_FILE_EXTENSIONS_EN,
  SIE_FILE_EXTENSIONS_SV,
  hasSIEFileExtension,
} from '../sie-file-extensions'
import { getErrorEntry } from '@/lib/errors/structured-errors'

describe('SIE file extensions', () => {
  it('accepts every SIE extension, case-insensitively', () => {
    expect(SIE_FILE_EXTENSIONS).toEqual(['.se', '.sie', '.si'])
    for (const extension of SIE_FILE_EXTENSIONS) {
      expect(hasSIEFileExtension(`bokforing${extension}`)).toBe(true)
      expect(hasSIEFileExtension(`BOKFORING${extension.toUpperCase()}`)).toBe(true)
    }
  })

  it('rejects other extensions', () => {
    for (const filename of ['bokforing.txt', 'bokforing.zip', 'bokforing.sie.zip', 'bokforing', '.se.pdf']) {
      expect(hasSIEFileExtension(filename)).toBe(false)
    }
  })

  it('names every accepted extension in the sv and en sentences', () => {
    for (const extension of SIE_FILE_EXTENSIONS) {
      expect(SIE_FILE_EXTENSIONS_SV).toContain(extension)
      expect(SIE_FILE_EXTENSIONS_EN).toContain(extension)
    }
  })

  it('names every accepted extension in the SIE_PARSE_INVALID_TYPE message', () => {
    const entry = getErrorEntry('SIE_PARSE_INVALID_TYPE')!
    for (const extension of SIE_FILE_EXTENSIONS) {
      expect(entry.message_sv).toContain(extension)
      expect(entry.message_en).toContain(extension)
    }
  })
})
