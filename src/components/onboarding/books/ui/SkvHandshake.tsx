'use client'

import type { SkvPhase } from '@/lib/onboarding-books/reducer'

/**
 * Stämpeln: a neutral authority mark on its white chip, alone, with air
 * around it (never Skatteverket's logo: its API terms forbid using it in
 * information or marketing). While the user is at Skatteverket a faint
 * dashed ring turns slowly outside the chip. On return the chip's own border
 * turns sage as one
 * stroke travels around it, then a small check badge appears at its lower
 * right. Nothing else moves. Every phase is a class on the svg.
 *
 * With `idle` the chip and its mark already stand before anything is signed
 * (the open and leaving phases), so the step has its mark from the start and
 * the same chip carries the ring and the badge later. `mark="tax"` draws the
 * app's own mark for its tax pages (the percent badge) on the chip. `compact`
 * drops the room the hold line takes under the chip: the caller then says the
 * hold text itself.
 */
export function SkvHandshake({
  phase,
  holdText,
  mark = 'authority',
  idle = false,
  compact = false,
}: {
  phase: SkvPhase
  holdText: string
  leftLabel?: string
  rightLabel?: string
  mark?: 'authority' | 'tax'
  idle?: boolean
  compact?: boolean
}) {
  const cls = phase === 'away' ? 'is-away' : phase === 'back' ? 'is-back' : phase === 'done' ? 'is-back is-done' : idle ? 'is-idle' : ''
  return (
    <div className={`skv-stage${compact ? ' is-compact' : ''}`}>
      <svg className={`stamp ${cls}`} viewBox="0 0 240 200" width="240" height="200" aria-hidden="true">
        <circle className="wait" cx="120" cy="88" r="56" />
        <circle className="chip" cx="120" cy="88" r="44" />
        <g className="mark">
          {/* Heroicons drawn inline: an icon component renders HTML, which cannot sit inside this svg. */}
          <svg x="100" y="68" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            {mark === 'tax' ? (
              <>
                <path d="M20.9899 11.994C20.9899 13.2624 20.3603 14.3838 19.3966 15.0625C19.598 16.2238 19.2503 17.4618 18.3537 18.3586C17.457 19.2554 16.2192 19.603 15.058 19.4016C14.3793 20.3653 13.2582 20.9949 11.9901 20.9949C10.7219 20.9949 9.60083 20.3654 8.92216 19.4017C7.7608 19.6034 6.52272 19.2557 5.62589 18.3588C4.72906 17.4618 4.38145 16.2236 4.58306 15.0622C3.61963 14.3834 2.99023 13.2622 2.99023 11.994C2.99023 10.7258 3.61968 9.60457 4.58318 8.92582C4.38168 7.76442 4.7293 6.52634 5.62605 5.62949C6.52282 4.73262 7.76077 4.38496 8.92206 4.5865C9.60071 3.62277 10.7219 2.99316 11.9901 2.99316C13.2582 2.99316 14.3793 3.62272 15.058 4.58638C16.2193 4.38474 17.4574 4.73239 18.3542 5.62932C19.251 6.52624 19.5987 7.76443 19.3971 8.92591C20.3605 9.60467 20.9899 10.7258 20.9899 11.994Z" />
                <path d="M8.99044 14.9934L14.9903 8.99282" />
                <path d="M9.74042 9.74289H9.74792V9.75039H9.74042V9.74289ZM10.1154 9.74289C10.1154 9.95002 9.94752 10.1179 9.74042 10.1179C9.53332 10.1179 9.36543 9.95002 9.36543 9.74289C9.36543 9.53576 9.53332 9.36785 9.74042 9.36785C9.94752 9.36785 10.1154 9.53576 10.1154 9.74289Z" />
                <path d="M14.2403 14.2433H14.2478V14.2508H14.2403V14.2433ZM14.6153 14.2433C14.6153 14.4504 14.4474 14.6184 14.2403 14.6184C14.0332 14.6184 13.8653 14.4504 13.8653 14.2433C13.8653 14.0362 14.0332 13.8683 14.2403 13.8683C14.4474 13.8683 14.6153 14.0362 14.6153 14.2433Z" />
              </>
            ) : (
              <path d="M8.25 12.75v8.25M12 12.75v8.25M15.75 12.75v8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0 0 12 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75Z" />
            )}
          </svg>
        </g>
        <circle className="ring" cx="120" cy="88" r="44" pathLength="1" transform="rotate(-90 120 88)" />
        <g transform="translate(152 120)">
          <g className="badge">
            <circle r="13" />
            <path d="M-5 0.5 L-1.5 4 L5.5 -4" pathLength="1" />
          </g>
        </g>
        {holdText ? <text className="hold" x="120" y="180">{holdText}</text> : null}
      </svg>
    </div>
  )
}
