import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { hourIn, useClockValue, useRenderedNow } from '../use-clock-value'

function Hour() {
  return createElement('span', null, useClockValue(hourIn))
}

/** The hour the server renders at `iso`, the way Next.js renders a client component. */
function serverRenderedHour(iso: string): number {
  vi.setSystemTime(new Date(iso))
  return Number(renderToString(createElement(Hour)).replace(/<\/?span>/g, ''))
}

describe('hourIn', () => {
  it('reads the hour in the given zone, summer and winter time', () => {
    expect(hourIn(new Date('2026-10-20T08:30:00Z'), 'Europe/Stockholm')).toBe(10)
    expect(hourIn(new Date('2026-12-01T08:30:00Z'), 'Europe/Stockholm')).toBe(9)
    expect(hourIn(new Date('2026-10-20T22:30:00Z'), 'Europe/Stockholm')).toBe(0)
    expect(hourIn(new Date('2026-10-20T08:30:00Z'), 'UTC')).toBe(8)
  })

  it('reads the runtime zone without one', () => {
    const now = new Date('2026-10-20T08:30:00Z')
    expect(hourIn(now)).toBe(now.getHours())
  })
})

describe('useClockValue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Error #418 on Hem: at 10:30 in Stockholm a UTC server rendered hour 8,
  // the greeting "Godmorgon", and the browser hydrated hour 10, "God dag".
  it('renders on the server in Stockholm time, whatever zone the server runs in', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    expect(serverRenderedHour('2026-10-20T08:30:00Z')).toBe(10)
  })

  // Hydration reads the same Stockholm snapshot, so the two renders agree at
  // every hour, including the ones PostHog showed failing (00-01, 05-06,
  // 10-11, 14-15, 17-19 Stockholm summer time) and across both clock changes.
  it.each(['2026-10-20', '2026-12-01', '2026-03-29', '2026-10-25'])('agrees with the Stockholm hour all day on %s', (day) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let utcHour = 0; utcHour < 24; utcHour++) {
      const iso = `${day}T${String(utcHour).padStart(2, '0')}:30:00Z`
      expect(serverRenderedHour(iso)).toBe(hourIn(new Date(iso), 'Europe/Stockholm'))
    }
  })
})

describe('useRenderedNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function Now({ renderedAt }: { renderedAt: number }) {
    return createElement('span', null, useRenderedNow(renderedAt))
  }

  // React #418 on /chat: seconds pass between the server render and
  // hydration, so a label counted from each render's own clock read "4 min"
  // on the server and "5 min" in the browser. Both renders count from the
  // server's instant instead, handed down as a prop.
  it('renders the instant the server rendered at, not the clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T09:00:42Z'))
    const renderedAt = new Date('2026-10-27T09:00:41.250Z').getTime()
    expect(renderToString(createElement(Now, { renderedAt }))).toBe(`<span>${renderedAt}</span>`)
  })
})
