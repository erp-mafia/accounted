import { describe, expect, it } from 'vitest'
import { UsageError } from '../lib/errors.mjs'
import { decode, readArguments } from '../lib/input.mjs'
import { stdinFrom } from './helpers'

function deps(files: Record<string, Buffer> = {}, stdinText = '', platform = 'linux') {
  return {
    readFile: async (file: string) => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return files[file]
    },
    stdin: stdinFrom(stdinText),
    platform,
  }
}

describe('readArguments', () => {
  it('is an empty object when no arguments are given', async () => {
    expect(await readArguments(undefined, deps())).toEqual({})
  })

  it('parses inline JSON and keeps account numbers as strings', async () => {
    expect(await readArguments('{"account": "1930", "amount": 125.5}', deps())).toEqual({
      account: '1930',
      amount: 125.5,
    })
  })

  it('reads standard input only when asked for with -', async () => {
    expect(await readArguments('-', deps({}, '{"limit": 5}'))).toEqual({ limit: 5 })
  })

  it('reads a file given as @path', async () => {
    const file = Buffer.from('{"name": "Åkeri AB"}', 'utf8')
    expect(await readArguments('@args.json', deps({ 'args.json': file }))).toEqual({ name: 'Åkeri AB' })
  })

  it('refuses a missing file, a bare @, and non-object JSON', async () => {
    await expect(readArguments('@nope.json', deps())).rejects.toThrow('Cannot read nope.json: ENOENT')
    await expect(readArguments('@', deps())).rejects.toThrow(UsageError)
    await expect(readArguments('[1, 2]', deps())).rejects.toThrow('must be a JSON object')
    await expect(readArguments('null', deps())).rejects.toThrow('must be a JSON object')
    await expect(readArguments('"text"', deps())).rejects.toThrow('must be a JSON object')
  })

  it('points PowerShell users at a file when inline JSON lost its quotes', async () => {
    await expect(readArguments('{limit:5}', deps({}, '', 'win32'))).rejects.toThrow("'@file.json'")
    const elsewhere = await readArguments('{limit:5}', deps()).catch((err: Error) => err)
    expect(elsewhere).toBeInstanceOf(UsageError)
    expect((elsewhere as Error).message).not.toContain("'@file.json'")
  })
})

describe('decode', () => {
  it('drops a UTF-8 byte order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":"ö"}', 'utf8')])
    expect(decode(bytes, 'x')).toBe('{"a":"ö"}')
  })

  it('decodes UTF-16LE with a BOM, as Windows PowerShell 5.1 writes it', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":"å"}', 'utf16le')])
    expect(decode(bytes, 'x')).toBe('{"a":"å"}')
  })

  it('decodes UTF-16BE with a BOM', () => {
    const le = Buffer.from('{"a":"ä"}', 'utf16le')
    const be = Buffer.alloc(le.length)
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]
      be[i + 1] = le[i]
    }
    expect(decode(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'x')).toBe('{"a":"ä"}')
  })

  it('refuses bytes that are not UTF-8 instead of inventing replacement characters', () => {
    // "Å" in Latin-1: a single 0xC5 byte, invalid as UTF-8.
    expect(() => decode(Buffer.from([0x7b, 0x22, 0xc5, 0x22, 0x7d]), 'args.json')).toThrow(
      'args.json is not UTF-8 text'
    )
  })
})
