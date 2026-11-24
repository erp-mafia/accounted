/**
 * A skill or knowledge file opens with YAML front matter: a block between
 * two `---` lines that names and routes the file (`name:`, `description:`
 * and the like). The block is part of the text an agent reads, and it is not
 * prose: rendered as Markdown it becomes a rule and one run-on paragraph
 * above the first heading. A screen that shows the text shows it from after
 * the block, and still copies the whole.
 *
 * Browser-safe and dependency-free: the pages that show a text import it.
 */

/**
 * A front matter block at the very start of a text (a byte order mark before
 * it is passed over): a line that is `---`, any lines, and the next line
 * that is `---`. Line endings are LF or CRLF, and the closing line may be the
 * last of the text.
 */
const LEADING_BLOCK = /^﻿?---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/

/** A `key:` line, which is how front matter begins. */
const KEY_LINE = /^[A-Za-z_][\w-]*:(?:\s|$)/

/**
 * The text from after its leading front matter, without the blank lines that
 * follow the block. The text comes back unchanged when it has no such block:
 *
 *   - a `---` further down is a rule in the text, never front matter;
 *   - a block that never closes is not front matter;
 *   - a leading `---` whose first line is not a `key:` line is a rule the
 *     text happens to start with, and what follows it is the text.
 */
export function stripFrontMatter(text: string): string {
  const match = LEADING_BLOCK.exec(text)
  if (!match) return text
  const firstLine = match[1].split(/\r?\n/).find((line) => line.trim() !== '')
  if (firstLine === undefined || !KEY_LINE.test(firstLine)) return text
  return text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
}
