/**
 * Interim "finalizing" page for the Enable Banking OAuth callback.
 *
 * The callback has seconds of unavoidable server work between the bank's
 * redirect and our own (session exchange with Enable Banking, account
 * mirroring, audit events). A classic 307 would leave the user staring at a
 * blank browser tab for that whole window, which reads as "the connection
 * failed" and provokes retries (and, historically, duplicate connections).
 *
 * Instead the route streams this page in two chunks:
 *   1. renderFinalizeShell()    - flushed immediately, before any slow work:
 *                                 branded spinner + "Slutför anslutningen".
 *   2. renderFinalizeRedirect() - flushed when the work is done: script +
 *                                 meta-refresh + visible fallback link that
 *                                 navigates to the settings page.
 *
 * The page is standalone HTML (no app bundle), styled to match the editorial
 * monochrome design system; see app/api/mcp-oauth/authorize for the sibling
 * standalone page this mirrors. Swedish-only, like the rest of the
 * enable-banking extension surfaces.
 *
 * Inline scripts are nonce-bound (ASVS V3.3): the route generates a
 * per-request nonce, stamps it on every <script> tag here, and sets a
 * response-level CSP with script-src 'nonce-...'. The global next.config CSP
 * (which still carries 'unsafe-inline' for the app bundle) also applies;
 * browsers enforce the intersection, so an injected inline script without
 * the nonce is blocked on this response.
 */

import { escapeHtml } from '@/lib/email/user-text'

/**
 * Opening chunk: full document head, styles, spinner and heading, plus a
 * watchdog that reveals an escape hatch if the server work takes abnormally
 * long (dead function, hung upstream). Deliberately does NOT close <body>:
 * the redirect chunk does. `cspNonce` must match the script-src nonce the
 * route puts in the response's Content-Security-Policy header.
 */
export function renderFinalizeShell(bankName: string | null, cspNonce: string): string {
  const heading = bankName
    ? `Slutf&ouml;r anslutningen till ${escapeHtml(bankName)}&hellip;`
    : 'Slutf&ouml;r bankanslutningen&hellip;'

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="light">
  <title>Slutf&ouml;r bankanslutningen</title>
  <style>
    :root {
      --bg: hsl(0 0% 100%);
      --border: hsl(45 5% 85%);
      --fg: hsl(0 0% 9%);
      --fg-muted: hsl(0 0% 40%);
      --fg-faint: hsl(0 0% 55%);
      --warm-accent: hsl(38 45% 52%);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: 'Geist', -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--fg);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem 1.5rem;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    main {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      max-width: 26rem;
    }
    .spinner {
      width: 28px;
      height: 28px;
      border: 2px solid var(--border);
      border-top-color: var(--fg);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 1.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      /* Keep a slow spin: a frozen spinner reads as a hung page. */
      .spinner { animation-duration: 2.5s; }
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.6875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-faint);
      margin-bottom: 0.875rem;
    }
    .eyebrow::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warm-accent);
    }
    h1 {
      font-family: 'Hedvig Letters Serif', Georgia, 'Times New Roman', serif;
      font-size: 1.625rem;
      font-weight: 400;
      letter-spacing: -0.018em;
      line-height: 1.15;
      margin-bottom: 0.625rem;
    }
    .lede {
      font-size: 0.875rem;
      color: var(--fg-muted);
      line-height: 1.55;
    }
    .slow {
      margin-top: 1.5rem;
      font-size: 0.8125rem;
      color: var(--fg-muted);
      line-height: 1.55;
    }
    .slow[hidden] { display: none; }
    a { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; }
    .fallback { margin-top: 1.25rem; font-size: 0.8125rem; }
  </style>
</head>
<body>
  <main role="main" aria-busy="true">
    <div class="spinner" aria-hidden="true"></div>
    <div class="eyebrow">Bankanslutning</div>
    <h1>${heading}</h1>
    <p class="lede">Vi bekr&auml;ftar anslutningen och h&auml;mtar dina konton fr&aring;n banken. Du skickas vidare automatiskt.</p>
    <p class="slow" id="slow-notice" hidden>
      Det tar l&auml;ngre tid &auml;n vanligt. V&auml;nta g&auml;rna kvar en stund till,
      eller <a href="/settings/banking">g&aring; till bankinst&auml;llningarna</a>.
    </p>
  </main>
  <script nonce="${escapeHtml(cspNonce)}">
    setTimeout(function () {
      var el = document.getElementById('slow-notice');
      if (el) el.hidden = false;
    }, 30000);
  </script>
`
}

/**
 * Closing chunk: navigates to `url` the instant it arrives. Three mechanisms,
 * most graceful first: location.replace (keeps the callback URL out of
 * history so Back cannot re-trigger it), a meta refresh for no-JS, and a
 * visible link as the last resort.
 */
export function renderFinalizeRedirect(url: string, cspNonce: string): string {
  // <-escape so a "</script>" sequence can never terminate the block
  // early, even though our URLs are app-relative and query-encoded.
  const jsUrl = JSON.stringify(url).replace(/</g, '\\u003c')

  return `  <script nonce="${escapeHtml(cspNonce)}">window.location.replace(${jsUrl});</script>
  <noscript><meta http-equiv="refresh" content="0;url=${escapeHtml(url)}"></noscript>
  <div class="fallback"><a href="${escapeHtml(url)}">Klicka h&auml;r om du inte skickas vidare automatiskt</a></div>
</body>
</html>
`
}
