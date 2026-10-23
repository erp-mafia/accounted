/**
 * The browser copy of the error registry (scripts/build/structured-errors-
 * browser-loader.cjs, applied by next.config.ts to browser bundles only) must
 * answer exactly like the real module for everything but remediation. Runs
 * against the real src/lib/errors/structured-errors.ts, so a new code is
 * covered without touching this file.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as real from '@/lib/errors/structured-errors'
import { getErrorMessage as realGetErrorMessage } from '@/lib/errors/get-error-message'

type Catalog = typeof real
const require = createRequire(import.meta.url)
const { browserCatalogSource } = require('../build/structured-errors-browser-loader.js') as {
  browserCatalogSource: (source: string, fileName?: string) => string
}

const SOURCE_PATH = path.resolve(__dirname, '../../src/lib/errors/structured-errors.ts')
const tempDirs: string[] = []
let emitted: string
let browser: Catalog

async function load(source: string): Promise<Catalog> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-errors-browser-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'structured-errors.mjs')
  fs.writeFileSync(file, source)
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Catalog
}

beforeAll(async () => {
  emitted = browserCatalogSource(fs.readFileSync(SOURCE_PATH, 'utf8'), SOURCE_PATH)
  browser = await load(emitted)
})

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('structured-errors browser loader', () => {
  it('carries every code in the registry order', () => {
    expect(browser.listErrorCodes()).toEqual(real.listErrorCodes())
  })

  it('answers every entry field but remediation', () => {
    for (const code of real.listErrorCodes()) {
      const { remediation: _remediation, ...expected } = real.getErrorEntry(code)!
      expect(browser.getErrorEntry(code), code).toEqual(expected)
      expect(browser.hasErrorEntry(code), code).toBe(true)
    }
  })

  it('leaves remediation text out of the emitted module', () => {
    const descriptions = real
      .listErrorCodes()
      .map((code) => real.getErrorEntry(code)!.remediation?.description)
      .filter((d): d is string => typeof d === 'string' && d.length > 40)
    expect(descriptions.length).toBeGreaterThan(0)
    for (const d of descriptions) expect(emitted.includes(JSON.stringify(d).slice(1, -1)), d).toBe(false)
  })

  it('answers unknown and prototype names like the real module', () => {
    for (const name of ['NOT_A_CODE', '', 'toString', 'constructor', 'hasOwnProperty', 'CONFLICT']) {
      expect(browser.hasErrorEntry(name), name).toBe(real.hasErrorEntry(name))
      expect(typeof browser.getErrorEntry(name), name).toBe(typeof real.getErrorEntry(name))
    }
  })

  it('maps database conflict names like the real module', () => {
    const inputs: unknown[] = [...real.listErrorCodes(), 'NOT_A_CODE', 'toString', '', undefined, null, 42, {}]
    for (const input of inputs) expect(browser.conflictCode(input), String(input)).toBe(real.conflictCode(input))
  })

  it('gives getErrorMessage the same answer for every code and locale', async () => {
    vi.resetModules()
    vi.doMock('@/lib/errors/structured-errors', () => browser)
    const { getErrorMessage } = await import('@/lib/errors/get-error-message')
    vi.doUnmock('@/lib/errors/structured-errors')
    for (const code of real.listErrorCodes()) {
      for (const locale of ['sv', 'en'] as const) {
        const envelopes: unknown[] = [
          { error: { code, message: 'raw engine text' } },
          { error: { code } },
          Object.assign(new Error(`${code}: detail`), { code }),
          { code: 'PT409', message: code },
        ]
        for (const envelope of envelopes) {
          expect(getErrorMessage(envelope, { locale }), `${code} ${locale}`).toBe(realGetErrorMessage(envelope, { locale }))
        }
      }
    }
  })

  it('answers SI_CREATE_INVALID_INPUT reasons like the real module', () => {
    expect(browser.SI_CREATE_INVALID_INPUT_REASONS).toEqual(real.SI_CREATE_INVALID_INPUT_REASONS)
    const inputs: unknown[] = [null, undefined, {}, { reason: 'toString' }, { reason: 42 }, { reason: 'nope' }]
    for (const reason of Object.keys(real.SI_CREATE_INVALID_INPUT_REASONS)) inputs.push({ reason })
    for (const input of inputs) {
      expect(browser.siCreateInvalidInputMessages(input), JSON.stringify(input)).toEqual(real.siCreateInvalidInputMessages(input))
    }
  })

  it('refuses a registry that gains an export or an import', () => {
    expect(() => browserCatalogSource(`export const EXTRA = 1\nexport function listErrorCodes() { return [] }`)).toThrow(/EXTRA/)
    expect(() => browserCatalogSource(`import x from 'somewhere'\nexport const y = x`)).toThrow(/somewhere/)
  })
})
