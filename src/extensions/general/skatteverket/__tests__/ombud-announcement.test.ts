import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The automated ombud announcement mail (MR !1346) was removed: the founder
// announces features himself and does not want the app mailing customers about
// them. Nothing may schedule or ship it again.

const root = process.cwd()

describe('ombud announcement mail', () => {
  it('has no sender module', () => {
    expect(existsSync(join(root, 'src/extensions/general/skatteverket/lib/ombud-announcement.ts'))).toBe(false)
    expect(existsSync(join(root, 'src/lib/email/skatteverket-ombud-announcement-templates.ts'))).toBe(false)
  })

  it('is not scheduled on Vercel or self-hosted', () => {
    expect(readFileSync(join(root, 'vercel.json'), 'utf8')).not.toContain('ombud/announcement')
    expect(readFileSync(join(root, 'docker/crontab.self-hosted'), 'utf8')).not.toContain('ombud/announcement')
  })
})
