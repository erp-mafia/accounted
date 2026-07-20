import { ILLUSTRATIONS, illustrationSrc } from './onboarding-illustrations'

// Ambient scene behind the onboarding flow, built from the marketing site's
// halftone illustration set so signup -> app feels like one product: the
// Stockholm skyline dissolving into the bottom edge. Purely decorative
// (aria-hidden, pointer-events-none); the content column sits above it on
// z-10.
export default function OnboardingBackdrop() {
  const skyline = ILLUSTRATIONS['about-stockholm']

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
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
    </div>
  )
}
