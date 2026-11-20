import { UsageError } from './errors.mjs'

/**
 * Tool arguments, as JSON only: inline, `@file.json`, or `-` for standard
 * input. There is deliberately no `--flag value` mapping: guessing types
 * would turn an account number such as "1930" into a number, and account
 * numbers are identifiers. Standard input is read only when asked for with
 * `-`; reading it implicitly hangs when an agent leaves a pipe open.
 *
 * @param {string | undefined} raw
 * @param {{
 *   readFile: (path: string) => Promise<Buffer>,
 *   stdin: NodeJS.ReadableStream,
 *   platform: string,
 * }} deps
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readArguments(raw, { readFile, stdin, platform }) {
  if (raw === undefined) return {}
  let text
  if (raw === '-') {
    text = decode(await readAll(stdin), 'Standard input')
  } else if (raw.startsWith('@')) {
    const file = raw.slice(1)
    if (!file) throw new UsageError('Name the file after @, for example @args.json')
    let bytes
    try {
      bytes = await readFile(file)
    } catch (err) {
      throw new UsageError(`Cannot read ${file}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'}`)
    }
    text = decode(bytes, file)
  } else {
    text = raw
  }

  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    const hint =
      platform === 'win32'
        ? " PowerShell can strip the quotes inside an argument: put the JSON in a file and pass '@file.json'."
        : ''
    throw new UsageError(`The arguments are not valid JSON (${/** @type {Error} */ (err).message}).${hint}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('The arguments must be a JSON object, for example {"limit": 5}')
  }
  return value
}

/**
 * Text from bytes: a UTF-8 BOM is dropped, UTF-16 with a BOM (what Windows
 * PowerShell 5.1 writes with `>`) is decoded, and anything else must be valid
 * UTF-8. Invalid bytes are refused rather than turned into U+FFFD, which would
 * end up in a customer name.
 *
 * @param {Buffer} bytes
 * @param {string} source
 */
export function decode(bytes, source) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new UsageError(`${source} is not UTF-8 text. Save it as UTF-8 and try again.`)
  }
}

/** @param {NodeJS.ReadableStream} stream @returns {Promise<Buffer>} */
function readAll(stream) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    stream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}
