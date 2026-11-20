/**
 * A SQL file with its comments taken out, for comparing two versions of a
 * migration: equal results mean the two differ in comments only.
 *
 * What is kept byte for byte: string literals ('...', E'...'), quoted
 * identifiers ("...") and dollar-quoted bodies ($$...$$, $tag$...$tag$),
 * including any `--` or `/*` inside them. A comment inside a function body
 * is part of the function's stored source, so it counts as SQL here.
 *
 * What is folded: outside those, a run of whitespace, with any comments in
 * it, becomes one space. Removing a whole comment line or a trailing comment
 * is therefore no difference; commenting a statement out is one.
 *
 * @param {string} sql
 * @returns {string}
 */
export function sqlWithoutComments(sql) {
  const out = []
  const n = sql.length
  let folded = true // the output so far ends in folded whitespace (or is empty)
  let codeStart = 0
  let i = 0

  const pushCode = (end) => {
    if (end <= codeStart) return
    let text = sql.slice(codeStart, end).replace(/\s+/g, ' ')
    if (folded) text = text.replace(/^ /, '')
    if (text) {
      out.push(text)
      folded = text.endsWith(' ')
    }
  }
  const pushGap = () => {
    if (!folded) {
      out.push(' ')
      folded = true
    }
  }
  const pushVerbatim = (end) => {
    out.push(sql.slice(i, end))
    folded = false
  }
  const dollarTag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y

  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      pushCode(i)
      const eol = sql.indexOf('\n', i)
      pushGap()
      i = eol === -1 ? n : eol
      codeStart = i
    } else if (c === '/' && sql[i + 1] === '*') {
      pushCode(i)
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth += 1
          j += 2
        } else if (sql.startsWith('*/', j)) {
          depth -= 1
          j += 2
        } else j += 1
      }
      pushGap()
      i = j
      codeStart = i
    } else if (c === "'") {
      pushCode(i)
      // E'...' strings escape with a backslash; plain ones only double the quote.
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]))
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") {
          j += 1
          break
        } else j += 1
      }
      pushVerbatim(Math.min(j, n))
      i = Math.min(j, n)
      codeStart = i
    } else if (c === '"') {
      pushCode(i)
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2
        else if (sql[j] === '"') {
          j += 1
          break
        } else j += 1
      }
      pushVerbatim(Math.min(j, n))
      i = Math.min(j, n)
      codeStart = i
    } else if (c === '$' && !(i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1]))) {
      dollarTag.lastIndex = i
      const tag = dollarTag.exec(sql)?.[0]
      if (!tag) {
        i += 1
        continue
      }
      pushCode(i)
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? n : close + tag.length
      pushVerbatim(end)
      i = end
      codeStart = i
    } else i += 1
  }
  pushCode(n)
  const result = out.join('')
  return folded && result.endsWith(' ') ? result.slice(0, -1) : result
}
