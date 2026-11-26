/**
 * The markup replacements the HTML-to-text helpers make on mail bodies
 * (documents/read/text.ts, the invoice inbox's htmlToText and the Gmail body
 * reader), in time that grows with the body.
 *
 * As plain global regexes they give the right text, but markup that is never
 * closed makes them search the rest of the body again from every opening: a
 * body of '<' repeated, or of '<!--' with no '-->', took seconds per 100 KB
 * and many minutes for a few MB. Each helper here gives exactly what its
 * regex gave.
 */

/**
 * `text.replace(pattern, by)` for a global pattern whose every match ends
 * with `closer`. No match can end after the last closer, so the pattern runs
 * on the text up to there, where every opening still has a closer ahead of
 * it, and the rest is kept as it is.
 */
export function replaceUpToLastCloser(text: string, pattern: RegExp, by: string, closer: string | RegExp): string {
  const cut = endOfLast(text, closer)
  if (cut < 0) return text
  return text.slice(0, cut).replace(pattern, by) + text.slice(cut)
}

/** Where the last occurrence of `closer` ends, or -1 when there is none. */
function endOfLast(text: string, closer: string | RegExp): number {
  if (typeof closer === 'string') {
    const at = text.lastIndexOf(closer)
    return at < 0 ? -1 : at + closer.length
  }
  const search = new RegExp(closer.source, closer.flags.includes('g') ? closer.flags : `${closer.flags}g`)
  let end = -1
  for (let m = search.exec(text); m; m = search.exec(text)) {
    end = m.index + m[0].length
    if (m[0] === '') search.lastIndex += 1
  }
  return end
}

/**
 * How an end tag closes a block: `attributes` is `</name` and anything up to
 * the next '>' (`<\/name[^>]*>`), `spaces` is `</name`, whitespace and '>'
 * (`<\/name\s*>`).
 */
export type BlockEnd = 'attributes' | 'spaces'

/**
 * `text.replace(/<(tags)\b[^>]*>[\s\S]*?<\/\1 END/gi, by)`: every block from
 * its opening tag to the first end tag of the same name, with END as `end`
 * says. Tags are plain lowercase names. Once a block of one name cannot be
 * closed, no later block of that name can be, so each name is searched to the
 * end of the text at most once.
 */
export function replaceBlocks(text: string, tags: readonly string[], end: BlockEnd, by: string): string {
  const opening = new RegExp(`<(${tags.join('|')})\\b`, 'gi')
  const endTags = new Map(tags.map((tag) => [tag, new RegExp(end === 'spaces' ? `<\\/${tag}\\s*>` : `<\\/${tag}`, 'gi')]))
  const unclosable = new Set<string>()
  let out = ''
  let from = 0
  for (let m = opening.exec(text); m; m = opening.exec(text)) {
    const tag = m[1]!.toLowerCase()
    if (unclosable.has(tag)) continue
    const blockEnd = endOfBlock(text, m.index + m[0].length, endTags.get(tag)!, end)
    if (blockEnd < 0) {
      unclosable.add(tag)
      opening.lastIndex = m.index + 1
      continue
    }
    out += text.slice(from, m.index) + by
    from = blockEnd
    opening.lastIndex = blockEnd
  }
  return out + text.slice(from)
}

/** Where the block whose opening tag name ends at `afterName` ends, or -1 when nothing closes it. */
function endOfBlock(text: string, afterName: number, endTag: RegExp, end: BlockEnd): number {
  const openingEnd = text.indexOf('>', afterName)
  if (openingEnd < 0) return -1
  endTag.lastIndex = openingEnd + 1
  const m = endTag.exec(text)
  if (!m) return -1
  if (end === 'spaces') return m.index + m[0].length
  const close = text.indexOf('>', m.index + m[0].length)
  return close < 0 ? -1 : close + 1
}
