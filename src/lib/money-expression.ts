import { parseDecimalInput, roundOre } from '@/lib/money'

/**
 * Arithmetic in amount fields.
 *
 * Paper bookkeeping is done next to a calculator, and every desktop ledger
 * program from GnuCash onwards lets you type the calculation straight into the
 * amount cell: `1200+300` for two receipts on one line, `4500*0.25` for the
 * moms, `12500/3` for a cost split three ways. An amount field that reads one
 * amount (parseAmountInput) refuses `1200+300`, so the sum had to be worked
 * out elsewhere first.
 *
 * This is a deliberately tiny recursive-descent parser rather than a dependency
 * (mathjs and friends are two orders of magnitude larger than the four
 * operators actually wanted here, and the repo audits its dependency surface).
 * It understands `+ - * /`, parentheses and unary sign; each number in it is
 * read with the same grammar as a plain amount field (parseDecimalInput), so a
 * plain amount means here exactly what it means to parseAmountInput. Nothing
 * else: no variables, no functions, no exponentiation, and nothing is ever
 * handed to eval or Function, so there is no evaluation surface to abuse.
 *
 * Invalid input returns null, and callers must leave the user's text alone when
 * it does. Never coerce an unparseable amount to zero: a silently zeroed line
 * is exactly the class of error this function exists to remove.
 *
 * Two rules are deliberately lenient, both tested:
 *   - Whitespace is stripped everywhere, so it groups thousands. That makes a
 *     pasted "1 234,00" work, at the price of "1200 300" reading as 1200300.
 *     Pasting a formatted amount is routine; writing a sum as two
 *     space-separated numbers is not.
 *   - A second sign is unary, so "1200++300" is 1500, as in any calculator.
 */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }

/** Space, non-breaking space and narrow non-breaking space all group thousands. */
const WHITESPACE = /[\s  ]/g

function tokenize(input: string): Token[] | null {
  const s = input.replace(WHITESPACE, '')
  if (s === '') return null

  const tokens: Token[] = []
  let i = 0

  while (i < s.length) {
    const c = s[i]

    // U+2212, the minus sign a pasted formatted amount can carry, is a minus.
    if (c === '+' || c === '-' || c === '\u2212' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', value: c === '\u2212' ? '-' : c })
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen' })
      i++
      continue
    }

    // A number: the run of digits and decimal marks, read with the grammar
    // every typed amount field uses (parseDecimalInput in lib/money.ts): a
    // comma or a point as the decimal, the other only grouping whole
    // thousands. A Swedish keyboard writes the comma, a numeric keypad the
    // point, and the user should not have to care.
    const start = i
    while (i < s.length && /[0-9.,]/.test(s[i])) i++
    if (i === start) return null // unrecognised character

    const value = parseDecimalInput(s.slice(start, i))
    if (value === null) return null
    tokens.push({ kind: 'num', value })
  }

  return tokens
}

/**
 * expr   := term (('+' | '-') term)*
 * term   := unary (('*' | '/') unary)*
 * unary  := ('+' | '-')? unary | atom
 * atom   := number | '(' expr ')'
 */
function parse(tokens: Token[]): number | null {
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]

  function parseExpr(): number | null {
    let left = parseTerm()
    if (left === null) return null
    for (;;) {
      const t = peek()
      if (t?.kind !== 'op' || (t.value !== '+' && t.value !== '-')) return left
      pos++
      const right = parseTerm()
      if (right === null) return null
      left = t.value === '+' ? left + right : left - right
    }
  }

  function parseTerm(): number | null {
    let left = parseUnary()
    if (left === null) return null
    for (;;) {
      const t = peek()
      if (t?.kind !== 'op' || (t.value !== '*' && t.value !== '/')) return left
      pos++
      const right = parseUnary()
      if (right === null) return null
      // Division by zero yields Infinity or NaN, neither of which is an amount.
      if (t.value === '/' && right === 0) return null
      left = t.value === '*' ? left * right : left / right
    }
  }

  function parseUnary(): number | null {
    const t = peek()
    if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
      pos++
      const operand = parseUnary()
      if (operand === null) return null
      return t.value === '-' ? -operand : operand
    }
    return parseAtom()
  }

  function parseAtom(): number | null {
    const t = peek()
    if (t === undefined) return null
    if (t.kind === 'num') {
      pos++
      return t.value
    }
    if (t.kind === 'lparen') {
      pos++
      const inner = parseExpr()
      if (inner === null) return null
      if (peek()?.kind !== 'rparen') return null
      pos++
      return inner
    }
    return null
  }

  const result = parseExpr()
  // Trailing tokens mean the input was not a single well-formed expression.
  if (result === null || pos !== tokens.length) return null
  return result
}

/**
 * Evaluate an amount field's text. Returns the öre-rounded value, or null when
 * the text is not a well-formed expression (in which case the caller keeps the
 * raw text so the user can see and fix what they typed).
 *
 * A plain amount is the degenerate case: `parseAmountExpression('1200,50')` is
 * 1200.5, as parseAmountInput reads it.
 */
export function parseAmountExpression(raw: string): number | null {
  const tokens = tokenize(raw)
  if (tokens === null) return null
  const value = parse(tokens)
  if (value === null || !Number.isFinite(value)) return null
  return roundOre(value)
}
