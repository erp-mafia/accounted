import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBASReference } from '../bas-reference'

/**
 * The skills agents load (.claude/skills) must name the reverse-charge basis
 * accounts for services the way the kontoplan does: 4531-4533 are services
 * from outside the EU (momsdeklaration ruta 22), 4535-4537 services from
 * another EU country (ruta 21). The counter-intuitive numbering (the lower
 * number is the further country) got swapped in one industry skill (crm#1352),
 * and an agent following it books the basis in the wrong ruta.
 */

const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '.claude', 'skills')
const ACCOUNTS = ['4531', '4532', '4533', '4535', '4536', '4537']

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(full)
    return entry.name.endsWith('.md') ? [full] : []
  })
}

/** Outside the EU or another EU country, read off the kontoplan's own account name. */
function isNonEu(account: string): boolean {
  const name = getBASReference(account)?.account_name ?? ''
  if (name.includes('utanför EU')) return true
  if (name.includes('annat EU-land')) return false
  throw new Error(`${account}: kontoplan name "${name}" says neither`)
}

const lines = markdownFiles(SKILLS_DIR).flatMap((file) =>
  fs.readFileSync(file, 'utf8').split('\n').map((text, i) => ({ where: `${path.relative(SKILLS_DIR, file)}:${i + 1}`, text })),
)

// A table row or verifikat line that names the account first: "| **4531** | Inköp ... |" or "4531 Inköp ...  1 000 D".
const NAMED = /^(?:\|\s*\**(453[1-7])\**\s*\|([^|]+)\||\s*(453[1-7])\s+(Inköp[^\d]+))/
const ACCOUNT = /(?<!\d)(453[1-7])(?!\d)/g
const RUTA = /ruta\s*\**\s*(2[12])(?!\d)/gi

describe('reverse-charge service accounts in the skills', () => {
  it('reads EU and non-EU off the kontoplan names', () => {
    expect(ACCOUNTS.map(isNonEu)).toEqual([true, true, true, false, false, false])
  })

  it('names 4531-4533 as outside the EU and 4535-4537 as another EU country', () => {
    const wrong: string[] = []
    let checked = 0
    for (const { where, text } of lines) {
      const m = NAMED.exec(text)
      if (!m) continue
      const account = m[1] ?? m[3]
      const name = (m[2] ?? m[4]).trim()
      checked++
      const saysNonEu = /utanför EU|icke-EU/.test(name)
      const saysEu = /annat EU-land/.test(name)
      if (isNonEu(account) ? !saysNonEu || saysEu : !saysEu || saysNonEu) wrong.push(`${where}: ${account} "${name}"`)
    }
    expect(checked).toBeGreaterThan(0)
    expect(wrong).toEqual([])
  })

  it('reports 4531-4533 in ruta 22 and 4535-4537 in ruta 21 on lines that pair one account with one ruta', () => {
    const wrong: string[] = []
    let checked = 0
    for (const { where, text } of lines) {
      const accounts = new Set([...text.matchAll(ACCOUNT)].map((m) => m[1]))
      const rutor = new Set([...text.matchAll(RUTA)].map((m) => m[1]))
      if (accounts.size !== 1 || rutor.size !== 1) continue
      const [account] = accounts
      const [ruta] = rutor
      checked++
      if (ruta !== (isNonEu(account) ? '22' : '21')) wrong.push(`${where}: ${account} in ruta ${ruta}`)
    }
    expect(checked).toBeGreaterThan(0)
    expect(wrong).toEqual([])
  })
})
