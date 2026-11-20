import { describe, it, expect } from 'vitest'
import { TAX_DEADLINE_CONFIGS } from '../deadline-config'

describe('rot_rut_begaran deadline covers grön teknik', () => {
  it('keeps its type (row identity) and names both kinds in title and description', () => {
    const config = TAX_DEADLINE_CONFIGS.find((c) => c.type === 'rot_rut_begaran')!
    expect(config.titleTemplate).toBe('Begäran om utbetalning ROT/RUT och grön teknik {periodLabel}')
    expect(config.description).toContain('grön teknik')
    expect(config.priority).toBe('critical')
  })
})
