"use client";

import { useEffect, useState } from "react";

// Last-resort boundary: only fires when the root layout itself throws, so it
// renders its own <html> and must stay free of app providers/components
// (NextIntlClientProvider, CompanyContext, etc. are not mounted here). It is
// also server-rendered when the root layout throws during SSR, so the lazy
// initializer must never touch window without a guard.
//
// Like app/error.tsx, transient failures here (e.g. a token race in the first
// request after login) heal on a fresh request, so auto-reload ONCE before
// showing the manual fallback. A per-path, per-tab-session flag (a monotonic
// one-shot, not a time window that could still loop on a slow failing render)
// keeps the single reload from becoming a loop on a genuinely broken root layout.
const RELOAD_FLAG_PREFIX = "accounted:global-error-reloaded:";

function reloadKey(): string {
  return (
    RELOAD_FLAG_PREFIX +
    (typeof window !== "undefined" ? window.location.pathname : "")
  );
}

// support@gnubok.se is hardcoded on purpose: this boundary renders when the root
// layout failed, so the branding service and any provider are unavailable here.
const SUPPORT_EMAIL = "support@gnubok.se";

function decideInitialPhase(): "reloading" | "fallback" {
  if (typeof window === "undefined") return "reloading";
  try {
    if (window.sessionStorage.getItem(reloadKey())) return "fallback";
    // Claim the one-shot and reload only if it persisted: writing here (not in
    // the effect) keeps "mark reloaded" and "decide to reload" atomic, so a
    // failed write (quota full / blocked) falls through to 'fallback' instead
    // of reloading forever without ever recording it.
    window.sessionStorage.setItem(reloadKey(), "1");
    return "reloading";
  } catch {
    return "fallback";
  }
}

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [phase] = useState<"reloading" | "fallback">(decideInitialPhase);

  useEffect(() => {
    console.error("[global] Unhandled error:", error);
    // The one-shot flag is already claimed in decideInitialPhase, so reaching
    // 'reloading' guarantees it persisted: reload exactly once.
    if (phase === "reloading") window.location.reload();
  }, [phase, error]);

  return (
    <html lang="sv" translate="no">
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body>
        {phase === "fallback" ? (
          // The standalone frame by hand: nothing above this boundary
          // survives (no providers, no brand context), so it draws the same
          // column and panel with plain elements.
          <div className="flex min-h-dvh flex-col items-center bg-background pt-4 sm:bg-frame sm:px-4 sm:py-8">
            <main className="w-full px-4 pb-8 pt-4 sm:max-w-[400px] sm:rounded-xl sm:bg-background sm:p-6 sm:shadow-panel">
              <h1 className="text-xl text-strong">Något gick fel</h1>
              <p className="mt-1 text-sm text-foreground">
                Ett oväntat fel inträffade. Försök igen eller{" "}
                <a
                  href={`mailto:${SUPPORT_EMAIL}?subject=Oväntat fel`}
                  className="font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60"
                >
                  kontakta support
                </a>{" "}
                om problemet kvarstår.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="mt-5 flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
              >
                Försök igen
              </button>
            </main>
          </div>
        ) : null}
      </body>
    </html>
  );
}
