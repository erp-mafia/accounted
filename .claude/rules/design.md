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
- **Surfaces**: The page itself is a rounded panel (12px) floating on a warm-toned frame (`--frame`); the sidebar sits borderless on the frame. Cards sit flat on the page: no shadow, full-opacity hairline border (`border-border`), `rounded-lg` (8px). Card background matches page background; the border carries hierarchy. Dark mode drops the warm tint from secondary for a pure-gray mood shift; light mode keeps the beige.
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

## Locked UI-migration conventions

Decided during the 2026-07 concept work (dev_docs/ui_migration_plan.md); they apply system-wide and override anything below that conflicts.

1. **Frame layout.** The page is a rounded panel (12px) on a warm-toned frame (`--frame`). The panel keeps `--background`; the sidebar is borderless on the frame.
2. **Page title is exactly 24px/32px** Hedvig Letters Serif (`text-2xl leading-8` via PageHeader).
3. **Buttons are pills.** Radius 99px, default padding 7px 16px, 13px text. Set once in `components/ui/button.tsx`, app-wide, never per page.
4. **Table rows are one line.** Secondary info (descriptions, OCR, roles) belongs in the detail view or a click-popup, never as sub-rows in lists.
5. **Chips mark exceptions.** Normal states render as muted text; Badge only when the row deviates. Same chip on every row means the chip is wrong.
6. **Attention is one ochre sentence**, not a banner: the `.attn` pattern (12.5px, `--warning` tone, single line, optionally with an embedded action link). Max one per page. Addendum 2026-08-19: a page may show at most one global notice line sourced from `lib/notices` (highest priority wins, additional active notices collapse behind a quiet "+N till" inline expander) plus at most one page-domain attn line.
7. **Help text lives behind a "?"** right after the H1: a small (17px) circular button opening a popover anchored at the button. No instructional copy in the page flow.
8. **One context picker per page, far right in the toolbar**: fiscal year or account/source as a chip-dropdown with a check on the active choice. A chip that looks like a picker must be a picker.
9. **The primary action lives in the page header**, right side. Multiple create paths collapse into a split button whose caret menu remembers the last-used mode (persisted in `user_preferences`, not localStorage).
10. **Confirm up front, don't comment afterwards.** Actions that post or send open a small confirm dialog describing the outcome ("Bokförs som verifikat A-217 ...") instead of writing outcome text into the page afterwards.
11. **Content lands with stagger.** `.stagger-enter` is the standard entry for list/table content, on server render and on client-fetch completion alike.
12. **Status colors are data, not chrome**: sage/ochre/terracotta only in numbers, exception chips and `.attn`.
13. **Overlays**: centered modal for create/confirm (template, assistant, confirmations, settings); right slide-over for reviewing an object (Granskning detail). Both with veil, Esc, and click-outside.
14. **Manual base, AI as opt-in.** Base flows work without AI; AI entry points are clearly labeled discrete choices (e.g. "Skapa med assistenten") and no AI suggestion posts without Granskning.
15. **Settings speak "Fönster"** (founder-chosen 2026-07-25, applies to every settings tab). Settings content is flat hairline rows, never boxed cards: `SettingsGroup` / `SettingsRow` / `SettingsSectionHeader` from `components/settings/SettingsRows.tsx`. Toggles are switches, not checkboxes. Saving is a sticky bar that fades in only when the form is dirty (`components/settings/SettingsFormWrapper.tsx`); no always-visible save button. The settings surface is a 920x680 modal (`components/settings/SettingsModal.tsx`); switching tabs inside it updates the URL shallowly via `history.replaceState` (`SettingsRail.tsx`), never `router.replace`, which would remount the modal.
16. **One radius per role (the radius ladder, 2026-08-13).** Four tiers, tied to what a thing IS: pills for interactive toolbar controls (buttons, chips, pickers, segmented controls, toolbar search, count badges), `rounded-xl` (12px) for the overlay/panel tier (page panel, dialogs, slide-overs, command palette), `rounded-lg` (8px) for surfaces on the panel (cards, form fields, textareas, popover/dropdown/menu content, bordered boxes), `rounded-sm` (4px) for leaf elements nested inside 8px surfaces (menu items, checkboxes, kbd/code nubs, skeleton text lines). Toolbar controls share one height: `h-8`. `rounded-md`, bare `rounded`, `rounded-2xl` and arbitrary `rounded-[Npx]` are dead vocabulary, enforced by `check:guards` (off-ladder-radius). Nesting is concentric: pill-in-pill by construction, `rounded-sm` items inside `rounded-lg` content with ~4px inset.

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

**Radius ladder** (convention 16; enforced by `check:guards` off-ladder-radius). Radius communicates role, and every role has exactly one:

| Tier | Class | Use for |
|---|---|---|
| pill | `rounded-full` | Buttons, chips, badges, context pickers, segmented controls, toolbar search, count nubs, dots, avatars |
| 12px | `rounded-xl` | Page panel, dialogs, slide-overs, command palette, hero surfaces |
| 8px | `rounded-lg` | Cards, form inputs, textareas, popover/dropdown/menu content, bordered boxes, toasts |
| 4px | `rounded-sm` | Menu items, checkboxes, kbd/code/account-number nubs, skeleton text lines, small nested leaves |

**Forbidden radii:** `rounded-md`, bare `rounded`, `rounded-2xl`+, `rounded-[Npx]`. A search field is a pill in a toolbar (`ToolbarSearch`) and `rounded-lg` in a form or dialog (`Input`): the row it sits in decides, and mixing shapes in one row is the bug the ladder exists to prevent.

**Layout (frame layout).**
- The dashboard wrapper is `bg-frame` (`--frame: 40 18% 96%` light, `0 0% 5%` dark). `<main>` is the page panel: `bg-background rounded-xl border border-border`, 10px margin against the frame, own inner scroll (`md:h-[calc(100vh-20px)] md:overflow-y-auto`). Defined once as `MAIN_PANEL_CLASS` in `app/(dashboard)/layout.tsx`; never restyle per page.
- The panel is the desktop scroll container: `position: sticky` binds to it automatically; never assume `window` scroll on dashboard pages. Scroll reset on navigation lives in `MainContainer`.
- Sidebar width: `md:w-64` (256px), borderless and transparent on the frame. Panel offset: `md:ml-64`.
- Main container: `max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10` (via `components/dashboard/MainContainer.tsx`).
- Page root: `<div className="space-y-8">`.
- Mobile keeps the pre-frame layout: full-width document flow, bottom nav; the panel styles are `md:`-gated.

**Primitives: always use these, don't hand-roll.**

| Need | Component | Notes |
|---|---|---|
| Page title + action | `components/ui/page-header.tsx` `PageHeader` | Use this, not bespoke `<h1>` + `<p>` blocks. Drop the `description` prop when it just paraphrases the title. |
| Data table, **page-level list** | `components/ui/dry-table.tsx` `TH_CLASS` / `TD_CLASS` on a plain `<table className="w-full border-collapse text-[13px]">`, rows `hover:bg-secondary/35` | The concept list table: borderless, straight on the panel, 13px rows, hairline heads. This is what every migrated list page uses. Add `tabular-nums` to numeric cells. Hover-revealed row controls use `HOVER_REVEAL_CLASS` from the same file, never a hand-rolled `opacity-0 group-hover:opacity-100` (coarse pointers never hover, so the control would be unreachable on touch). |
| Data table, **dialog or report view** | `components/ui/table.tsx` `Table / TableHeader / TableHead / TableRow / TableCell` | Header style is baked in: `text-[11px] font-medium uppercase tracking-wider text-muted-foreground`. Wrap in `<CardContent className="p-0">` when the table is a card's primary content. `TableCell` is `px-4 py-3` on `text-sm`, so a page-level list built from this primitive comes out ~15% taller with a different hover tint: use the dry-table row above instead. |
| Status indicator | `components/ui/badge.tsx` `<Badge variant>` | Chips mark exceptions only: normal states (Aktiv, Bokförd, Betald-i-tid) render as muted text (`text-muted-foreground text-xs`); Badge is reserved for rows that deviate (Utkast, Förfallen, Ej bokförd). A table where every row carries the same chip is wrong. Variants: `default / secondary / success / warning / destructive / outline`. **Never** use raw Tailwind colors (`bg-blue-100`, `bg-emerald-500/10`, etc.) for status. Map status → variant via a small `Record` per feature. |
| No-data state | `components/ui/empty-state.tsx` `EmptyState` | Don't hand-roll `<div className="flex flex-col items-center py-12">…</div>`. Preset variants exist (`EmptyCustomers`, `EmptyByraClients`). |
| Loading placeholder | `components/ui/skeleton.tsx` `<Skeleton>` | Don't hand-roll `bg-muted rounded animate-pulse` divs. |
| Inline help / formulas | `components/ui/info-tooltip.tsx` `InfoTooltip` | Hover-revealed; don't use always-visible info buttons. |
| View/mode switcher in a toolbar | `components/ui/segmented-control.tsx` `SegmentedControl` | Pill-in-pill tablist at the shared `h-8` toolbar height; `options` take an optional `count` for the standard count chip. Never hand-roll the `bg-muted/70` tablist div. |
| Search in a page toolbar | `components/ui/toolbar-search.tsx` `ToolbarSearch` | Pill search at `h-8`, matching the chips and pickers beside it. Searches inside dialogs/pickers keep the regular `Input`. |
| Fiscal year picker | `components/common/FyPicker.tsx` | The chip-dropdown context picker of convention 8 (wraps `ContextPicker`). `FiscalYearSelector` is the legacy pre-frame control: don't add new uses. Never use a raw `<select>` for fiscal periods. |
| Settings rows / save | `components/settings/SettingsRows.tsx`, `SettingsFormWrapper.tsx` | Fönster language (convention 15): flat hairline rows, dirty-only sticky save bar. Don't hand-roll settings cards or per-field save buttons. |

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
- Page title: use `PageHeader` (renders `font-display text-2xl leading-8 tracking-tight`, exactly 24px/32px, locked). Do not hand-roll an `<h1>`.
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
- `rounded-xl` (12px) on cards. Cards are `rounded-lg` (8px). `rounded-xl` is the overlay/panel tier: page panel, dialogs, slide-overs, hero surfaces.
- Off-ladder radii: `rounded-md`, bare `rounded`, `rounded-2xl`, `rounded-[Npx]`. See the radius ladder above; `check:guards` fails on any of them in `app/` or `components/`.
- Overriding the Button pill radius per call site (`rounded-lg`, `rounded-md` on a `<Button>`). Buttons are pills app-wide; the radius lives in `components/ui/button.tsx` alone.
- Opacity-suffixed border classes (`border-border/30`, `border-border/60`) on cards and primary surfaces. Use full-opacity `border-border`: the new border token is calibrated for that.
