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
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  SIE_FILE_EXTENSIONS,
  SIE_FILE_EXTENSION_PATTERN,
  SIE_FILE_EXTENSIONS_EN,
  SIE_FILE_EXTENSIONS_SV,
  hasSIEFileExtension,
  lacksFileExtension,
} from '../sie-file-extensions'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const SAMPLE_NAMES = [
  'bokforing.se', 'BOKFORING.SI', 'export.sie', 'bokforing.txt', 'bokforing.zip',
  'bokforing.sie.zip', 'bokforing', '.se.pdf', 'Bokföring 2025', 'bokforing.sek',
]

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

  it('gives the pattern the same verdict as hasSIEFileExtension, from the same list', () => {
    // The v1 upload schema publishes this as its OpenAPI pattern: unchanged
    // from the literal it replaced.
    expect(SIE_FILE_EXTENSION_PATTERN.source).toBe('\\.(se|sie|si)$')
    expect(SIE_FILE_EXTENSION_PATTERN.flags).toBe('i')
    for (const filename of SAMPLE_NAMES) {
      expect(SIE_FILE_EXTENSION_PATTERN.test(filename), filename).toBe(hasSIEFileExtension(filename))
    }
  })

  it('tells a file saved without an extension from one with another extension', () => {
    for (const filename of ['bokforing', 'Bokföring 2025', 'export 2024-12-31', 'SIE4 export.']) {
      expect(lacksFileExtension(filename), filename).toBe(true)
    }
    for (const filename of ['bokforing.se', 'bokforing.si', 'bokforing.txt', 'bokforing.zip', 'bokforing.pdf']) {
      expect(lacksFileExtension(filename), filename).toBe(false)
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

/*
 * accounted#32: the onboarding SIE step had its own `.se,.sie` accept literal
 * (so .si was greyed out) and a filter that let any non-empty file through to
 * fail late at the parse route. It now applies the shared rule.
 */
describe('the onboarding SIE step', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../../components/onboarding/books/steps/SieStep.tsx'),
    'utf8',
  )

  it('filters with the shared rule, not a literal of its own', () => {
    expect(src).toContain('hasSIEFileExtension(file.name)')
    expect(src).not.toMatch(/\\\.\((?:se|sie|si)\|/)
    expect(src).not.toContain('f.size > 0')
  })

  it('leaves the accept attribute off its picker, as the Import page does', () => {
    const input = src.slice(src.indexOf('<input ref={inputRef}'), src.indexOf('/>', src.indexOf('<input ref={inputRef}')))
    expect(input).toContain('type="file"')
    expect(input).not.toContain('accept=')
  })

  it('has the turn-away reasons in sv and en', () => {
    for (const messages of [sv, en]) {
      expect(messages.books.sie_wrong_type).toContain('{extensions}')
      expect(messages.books.sie_no_extension).toContain('.se')
    }
  })
})
