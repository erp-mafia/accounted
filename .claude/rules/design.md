---
paths:
  - "app/**"
  - "components/**"
---

# Design Context & Design System

Always use the `/frontend-design` skill for new UI. The conventions below are locked: deviating from them on existing pages is a regression.

## Users

Swedish sole traders (enskild firma) and small business owners (aktiebolag) who manage their own bookkeeping. They are not accountants; they are professionals (consultants, freelancers, shop owners) who want to stay compliant without hiring one. They use Accounted in short, focused sessions: sending an invoice, categorizing bank transactions, filing a VAT declaration. Speed and clarity matter.

## Brand & Aesthetic

**Editorial monochrome.** Paper-white surfaces, hairline borders, serif headlines. The interface should feel like a well-made instrument, considered, quiet, confident. Anti-references: enterprise software (SAP/Oracle density), neon SaaS coldness.

- **Palette**: Achromatic foundation. Pure white background, warm beige (`40 11% 89%`) for chips / active sidebar / hover / secondary buttons. Achromatic primary (no cool tint). Semantic colors (`--success` sage, `--warning` ochre, `--destructive` terracotta) exist but are **data-only**: they appear in charts and financial numbers (positive/negative deltas), never as chrome backgrounds. In chrome, only `--destructive` survives.
- **Typography**: Hedvig Letters Serif for display headings, Geist (sans) for body, forms, and tables. Hedvig is single-weight (400): do not apply `font-medium` to display text; its natural high-contrast strokes carry the weight. Tabular numbers everywhere financial data appears.
- **Surfaces**: Cards sit flat on the page: no shadow, full-opacity hairline border (`border-border`), `rounded-lg` (8px). Card background matches page background; the border carries hierarchy. Dark mode drops the warm tint from secondary for a pure-gray mood shift; light mode keeps the beige.
- **Spacing**: Generous whitespace. Dense data (tables, ledgers) uses tighter spacing but never feels cramped.
- **Motion**: Functional, not decorative. No press-scale, no hover-lift, no spring overshoot. Hover state is a flat background shift (`bg-secondary/60`). `transition-colors duration-150` is the default. Stagger animations on list entry are fine. Respect `prefers-reduced-motion` (already wired).
- **Icons**: Lucide: 15px in navigation, slightly larger in empty states.

## Design Principles

1. Clarity over cleverness: Swedish labels, obvious hierarchy.
2. Earned minimalism: remove what doesn't serve the task, keep compliance context.
3. Numbers are first-class: tabular-nums, alignment, positive/negative clarity.
4. Trust through consistency.
5. Speed is a feature: optimize for the 90-second session.

## Accessibility

WCAG AA (4.5:1 text, 3:1 UI). Keyboard-navigable + visible focus rings. Respect `prefers-reduced-motion`. Color never sole state indicator. Touch targets ≥40px (44px for mobile-critical). Icon-only buttons need `aria-label`.

## Design System Tokens

**Spacing scale.** Only use Tailwind values `1, 2, 3, 4, 6, 8, 10, 12`. **Forbidden:** `2.5`, `5`, hardcoded pixels in page logic.

| Token | Tailwind | Use for |
|---|---|---|
| 4 | `1` | icon padding |
| 8 | `2` | tight inline gaps |
| 12 | `3` | dense list rows, badge gaps |
| 16 | `4` | default form / control / grid gap |
| 24 | `6` | **card padding default** (`p-6`) |
| 32 | `8` | **between page sections** (`space-y-8` on page root) |
| 40 | `10` | hero spacing |
| 48 | `12` | top of page after header |

Compact metric cards (e.g. dashboard tiles, salary KPI row) use `p-4`. Detail cards use `p-6`. Never mix `p-5`.

**Layout.**
- Sidebar width: `md:w-64` (256px). Main content offset: `md:pl-64`.
- Main container: `max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10` (via `components/dashboard/MainContainer.tsx`).
- Page root: `<div className="space-y-8">`.

**Primitives: always use these, don't hand-roll.**

| Need | Component | Notes |
|---|---|---|
| Page title + action | `components/ui/page-header.tsx` `PageHeader` | Use this, not bespoke `<h1>` + `<p>` blocks. Drop the `description` prop when it just paraphrases the title. |
| Data table | `components/ui/table.tsx` `Table / TableHeader / TableHead / TableRow / TableCell` | Header style is baked in: `text-[11px] font-medium uppercase tracking-wider text-muted-foreground`. Wrap in `<CardContent className="p-0">` when the table is a card's primary content. Add `tabular-nums` to numeric cells. |
| Status indicator | `components/ui/badge.tsx` `<Badge variant>` | Variants: `default / secondary / success / warning / destructive / outline`. **Never** use raw Tailwind colors (`bg-blue-100`, `bg-emerald-500/10`, etc.) for status. Map status → variant via a small `Record` per feature. |
| No-data state | `components/ui/empty-state.tsx` `EmptyState` | Don't hand-roll `<div className="flex flex-col items-center py-12">…</div>`. Preset variants exist (`EmptyInvoices`, `EmptyCustomers`, `EmptyTransactions`, etc.). |
| Loading placeholder | `components/ui/skeleton.tsx` `<Skeleton>` | Don't hand-roll `bg-muted rounded animate-pulse` divs. |
| Inline help / formulas | `components/ui/info-tooltip.tsx` `InfoTooltip` | Hover-revealed; don't use always-visible info buttons. |
| Fiscal year picker | `components/common/FiscalYearSelector.tsx` | Don't use raw `<select>` for fiscal periods. |

**Tabular display rules.**
- All financial values get `tabular-nums`.
- Dates in tables: `tabular-nums` for fixed width.
- Right-align numeric columns (`text-right`).
- For group bands inside tables (Resultatrapport-style): `<tr className="bg-muted/30"><td colSpan={n} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">{label}</td></tr>`.

**Date formatting.** Two helpers in `lib/utils.ts`:
- `formatDate(x)` → `2026-05-11` (ISO `yyyy-MM-dd`). Use for accounting data: transaction dates, invoice dates, payment dates, voucher dates. Aligns in tables, matches SIE/BFL convention.
- `formatDateLong(x)` → `11 maj 2026` (Swedish long form). Use for metadata: when something was created, linked, verified, expires. Settings panels and audit displays.

Never render raw `{x.invoice_date}` directly: always route through `formatDate()` for code consistency.

**Currency.** `formatCurrency(n, currency?)` from `lib/utils.ts`. Default SEK.

**Typography.**
- Page title: use `PageHeader` (renders `font-display text-3xl md:text-4xl tracking-tight`). Do not hand-roll an `<h1>`.
- Card title: `<CardTitle className="text-base">` for sections, default for primary cards. The primitive already drops `font-medium`: do not add it back.
- Section divider header inside a page: `<h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">`.
- Headline number: `font-display text-xl tabular-nums`. No `font-medium`: Hedvig's natural weight carries the gravitas.
- Display font (`font-display`, Hedvig Letters Serif) reserved for h1/h2/h3 and primary financial numbers. If a specific `font-display` numeral reads weak inside a compact metric card, override that call site with `font-sans tabular-nums` (Geist), better legibility on small numerals.

**Forbidden / dead patterns.**
- Page descriptions that paraphrase the page title (e.g. `<PageHeader title="Fakturor" description="Hantera dina fakturor">`) → drop the description.
- Two different status indicators on the same element (e.g. colored card border *and* Badge for status) → pick one (prefer Badge).
- Mobile-specific `<select>` duplicating desktop tabs in code: use a single Tabs primitive or a single grouped `Select`.
- Hand-rolled icon buttons smaller than `h-10 w-10`. Use shadcn `Button size="icon"`.
- Color-coded status using full-rainbow Tailwind palette (`bg-amber-100`, `bg-emerald-500/10`, etc.). Use Badge variants tied to the brand palette.
- `shadow-sm` / `shadow-md` / `shadow-lg` on cards, buttons, or list items. The aesthetic is flat-with-hairlines: surfaces use `border-border`, not elevation. Shadows survive only on dialogs/popovers/dropdowns (anything that overlays the page).
- `active:scale-[...]` on buttons. Buttons do not bounce.
- `bg-gradient-to-*` on page or card backgrounds. Flat surfaces only.
- `font-medium` on display elements (`font-display`, h1/h2/h3, CardTitle, PageHeader title). Hedvig is single-weight by design.
- `rounded-xl` (12px) on cards. Cards are `rounded-lg` (8px). `rounded-xl` survives only on prominent hero-style surfaces if absolutely needed.
- Opacity-suffixed border classes (`border-border/30`, `border-border/60`) on cards and primary surfaces. Use full-opacity `border-border`: the new border token is calibrated for that.
