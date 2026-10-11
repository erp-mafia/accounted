import { roundOre } from '@/lib/money'

/**
 * Arithmetic in amount fields.
 *
 * Paper bookkeeping is done next to a calculator, and every desktop ledger
 * program from GnuCash onwards lets you type the calculation straight into the
 * amount cell: `1200+300` for two receipts on one line, `4500*0.25` for the
 * moms, `12500/3` for a cost split three ways. Accounted parsed amount fields
 * with a bare `parseFloat`, which reads `1200+300` as 1200 and books the wrong
 * number without a word.
 *
 * This is a deliberately tiny recursive-descent parser rather than a dependency
 * (mathjs and friends are two orders of magnitude larger than the four
 * operators actually wanted here, and the repo audits its dependency surface).
 * It understands `+ - * /`, parentheses, unary sign, Swedish decimal comma, and
 * spaces as thousands separators. Nothing else: no variables, no functions, no
 * exponentiation, so there is no evaluation surface to abuse.
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

    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', value: c })
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

    // A number: digits with at most one decimal separator, comma or point.
    // Both are accepted because a Swedish keyboard produces the comma and the
    // numeric keypad produces the point, and the user should not have to care.
    const start = i
    let seenSeparator = false
    while (i < s.length) {
      const d = s[i]
      if (d >= '0' && d <= '9') {
        i++
        continue
      }
      if ((d === ',' || d === '.') && !seenSeparator) {
        seenSeparator = true
        i++
        continue
      }
      break
    }
    if (i === start) return null // unrecognised character

    const literal = s.slice(start, i).replace(',', '.')
    const value = Number(literal)
    if (!Number.isFinite(value)) return null
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
 * A plain number is just the degenerate case, so this is a safe drop-in for the
 * `parseFloat` it replaces: `parseAmountExpression('1200,50')` is 1200.5.
 */
export function parseAmountExpression(raw: string): number | null {
  const tokens = tokenize(raw)
  if (tokens === null) return null
  const value = parse(tokens)
  if (value === null || !Number.isFinite(value)) return null
  return roundOre(value)
}

/**
 * Canonical text for an evaluated amount, written back into the field so the
 * user sees the number that will actually be booked before committing.
 *
 * Uses a point as the decimal separator because that is what the form state and
 * its `parseFloat` consumers already expect (and what fill-balance writes). No
 * trailing-zero padding: the field is an input, not a report column.
 */
export function formatAmountValue(value: number): string {
  return String(roundOre(value))
}
