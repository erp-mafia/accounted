/**
 * Data goes to stdout as JSON (indented in a terminal, one line in a pipe, so
 * agents pay fewer tokens); notes for the human or agent go to stderr.
 *
 * @param {{ write: (chunk: string) => unknown, isTTY?: boolean }} stream
 * @param {unknown} value
 */
export function writeJson(stream, value) {
  const pretty = stream.isTTY === true
  stream.write(`${JSON.stringify(value === undefined ? null : value, null, pretty ? 2 : undefined)}\n`)
}

/**
 * @param {{ write: (chunk: string) => unknown }} stream
 * @param {string} text
 */
export function writeNote(stream, text) {
  stream.write(`${text}\n`)
}

/** The 18 characters Settings shows for a key. @param {string} token */
export function keyPrefix(token) {
  return token.slice(0, 18)
}

/** @param {string | undefined} scope space-separated */
export function scopeList(scope) {
  return (scope ?? '').split(/\s+/).filter(Boolean)
}
