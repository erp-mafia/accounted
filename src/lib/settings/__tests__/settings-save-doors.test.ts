import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/*
 * Every settings control saves through useSaveSettings: one PUT, the
 * server's own reason on a refusal. A component writing its own
 * fetch('/api/settings') is the copy coming back, and the copies had drifted
 * (no reason shown, "[object Object]"). The VAT declaration's period chooser
 * keeps its own call on purpose: it shows the refusal inline under the
 * choices instead of in a toast.
 */
const root = path.resolve(__dirname, '../../../')

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('settings saves', () => {
  it('only the shared hook and the inline VAT chooser call /api/settings themselves', () => {
    const callers = ['components', 'app']
      .flatMap((dir) => filesUnder(path.join(root, dir)))
      .filter((file) => fs.readFileSync(file, 'utf8').includes("fetch('/api/settings'"))
      .map((file) => path.relative(root, file))
      .sort()
    expect(callers).toEqual([
      'components/reports/lazy-views/VatDeclarationView.tsx',
      'components/settings/use-save-settings.ts',
    ])
  })
})
