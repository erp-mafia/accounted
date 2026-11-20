/**
 * The heading type of the app's standalone HTML pages: the bank-connection
 * finish page and the MCP authorize page. They are served as plain HTML
 * outside the Next.js app, so they cannot read globals.css; this one copy
 * keeps them alike (Stil v3: a quiet 12px label above an Inter 500 title,
 * sentence case, no small caps). Each page declares the tokens it reads:
 * --fg, --fg-muted and --warm-accent.
 */
export const STANDALONE_HEADING_CSS = `
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--fg-muted);
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
      font-size: 1.25rem;
      font-weight: 500;
      letter-spacing: -0.006em;
      line-height: 1.15;
      color: var(--fg);
      margin-bottom: 0.625rem;
    }
`
