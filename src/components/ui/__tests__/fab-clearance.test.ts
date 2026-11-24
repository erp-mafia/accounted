/**
 * The floating assistant button and the page share the bottom right corner
 * (crm#1841). The wiring is CSS only, so a render test would not see it: these
 * checks keep the three ends connected. The button used to wait for an
 * attribute on <body> that nothing set, so it never lifted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_FAB_CLEARANCE_CLASS, AGENT_FAB_PROPS, PAGE_BOTTOM_BAR_PROPS } from '../fab-clearance'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const trigger = read('src/components/agent/AgentTrigger.tsx')

describe('assistant button clearance', () => {
  it('the button marks itself, and the clearance reads that marker', () => {
    expect(trigger).toContain('{...AGENT_FAB_PROPS}')
    for (const attr of Object.keys(AGENT_FAB_PROPS)) {
      expect(AGENT_FAB_CLEARANCE_CLASS).toContain(`body:has([${attr}])`)
    }
  })

  it('the button lifts on the marker a bottom bar renders, not on a body attribute', () => {
    for (const attr of Object.keys(PAGE_BOTTOM_BAR_PROPS)) {
      expect(trigger).toContain(`md:[body:has([${attr}])_&]:bottom-20`)
      expect(trigger).not.toContain(`body[${attr}]`)
      expect(AGENT_FAB_CLEARANCE_CLASS).toContain(`:has([${attr}])`)
    }
  })

  it('on a phone the collapsed handle lifts above a bottom bar too, measured from the bottom nav', () => {
    for (const attr of Object.keys(PAGE_BOTTOM_BAR_PROPS)) {
      expect(trigger).toContain(`max-md:[body:has([${attr}])_&]:bottom-[calc(var(--bottom-nav-h)+5.5rem)]`)
    }
  })

  it('the page and the transaction panel reserve the corner', () => {
    expect(read('src/components/dashboard/MainContainer.tsx')).toContain('AGENT_FAB_CLEARANCE_CLASS)')
    expect(read('src/components/transactions/TransactionDrawer.tsx')).toContain('AGENT_FAB_CLEARANCE_CLASS)')
  })

  it('every bottom bar with an action at its right end declares itself', () => {
    for (const path of [
      'src/components/ui/floating-bulk-bar.tsx',
      'src/app/(dashboard)/transactions/page.tsx',
      'src/components/reconciliation/ManualMatchMode.tsx',
    ]) {
      expect(read(path), path).toContain('{...PAGE_BOTTOM_BAR_PROPS}')
    }
  })
})
