import IllustrationFloaters, { type FloaterDef } from './IllustrationFloaters'
import { ILLUSTRATIONS, illustrationSrc } from './onboarding-illustrations'

// Two clouds drifting at reading pace: the one playful move on this surface.
// They bounce off the viewport and the onboarding panel (see
// data-onboarding-panel in app/(onboarding)/layout.tsx).
const FLOATERS: FloaterDef[] = [
  { name: 'cloud', size: 9, opacity: 0.45, top: 12, left: 8, speed: 9, vrot: 1.2 },
  { name: 'cloud', size: 5, opacity: 0.32, top: 62, left: 78, speed: 6, vrot: -0.8 },
]

// Ambient scene behind the onboarding flow, built from the marketing site's
// halftone illustration set so signup -> app feels like one product: a sparse
// petal field across the paper background and the Stockholm skyline
// dissolving into the bottom edge. Purely decorative (aria-hidden,
// pointer-events-none); the content column sits above it on z-10.
export default function OnboardingBackdrop() {
  const skyline = ILLUSTRATIONS['about-stockholm']
  const petals = ILLUSTRATIONS.petals

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* Petal field: faint pink ink scattered over the whole page. The
          radial mask thins the field to a calm zone behind the content
          column so petals never sit right under the form copy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={illustrationSrc('petals')}
        width={petals.w}
        height={petals.h}
        alt=""
        loading="eager"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover opacity-50 dark:opacity-25 dark:[filter:invert(1)_hue-rotate(180deg)]"
        style={{
          maskImage:
            'radial-gradient(ellipse 55% 60% at 50% 45%, transparent 25%, black 70%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 55% 60% at 50% 45%, transparent 25%, black 70%)',
        }}
      />

      {/* Stadshuset skyline anchored to the bottom: translated down so its
          water reflection falls below the fold and only the silhouette hugs
          the edge, masked so it dissolves upward into the page. min-width
          keeps the towers readable on narrow viewports (crops at the sides). */}
      <div className="absolute bottom-0 left-1/2 w-full min-w-[1100px] -translate-x-1/2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={illustrationSrc('about-stockholm')}
          width={skyline.w}
          height={skyline.h}
          alt=""
          loading="eager"
          decoding="async"
          className="block h-auto w-full translate-y-[36%] opacity-[0.12] dark:opacity-10 dark:invert"
          style={{
            maskImage: 'linear-gradient(to top, black 55%, transparent 95%)',
            WebkitMaskImage: 'linear-gradient(to top, black 55%, transparent 95%)',
          }}
        />
      </div>

      <IllustrationFloaters items={FLOATERS} obstacleSelector="[data-onboarding-panel]" />
    </div>
  )
}
