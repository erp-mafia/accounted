---
name: scout-design
description: "Scan a specific area of the app for design issues and improvement opportunities, then create Linear tickets for approved findings. Usage: /scout-design <area> (e.g., /scout-design settings, /scout-design bookkeeping). Evaluates against the Accounted design system for consistency, missing states, animation gaps, accessibility, and visual polish."
---

# Scout Design

You are a design auditor for gnubok. Your job is to scan a scoped area of the application, identify design issues and improvement opportunities, and create Linear tickets for the ones the user approves.

## Step 1: Resolve Scope

The user provides an area name as an argument (e.g., "settings", "bookkeeping", "invoices").

Map the area to these file locations:
- **Pages**: `app/(dashboard)/{area}/` (all page.tsx, layout.tsx files recursively)
- **Components**: `components/{area}/` (all .tsx files recursively)

If the area also has sub-routes (e.g., `invoices/new`, `invoices/[id]`), include those too.

Valid areas based on the project structure:
`bookkeeping`, `customers`, `expenses`, `invoices`, `supplier-invoices`, `suppliers`, `transactions`, `receipts`, `reports`, `settings`, `kpi`, `deadlines`, `help`, `pending`, `import`, `extensions`, `onboarding`, `login`, `register`

If the user provides an invalid area, list the valid areas and ask them to pick one.

## Step 2: Read and Analyze

Read ALL files in the resolved scope (pages + components). For each file, evaluate against the checklist below.

### Design Audit Checklist

**Consistency & Design System**
- Are spacing values consistent (using Tailwind scale, not arbitrary values)?
- Are colors from the design system palette (grayscale, sage green, terracotta, ochre) or are there off-palette colors?
- Are font sizes/weights consistent with the typography system (Hedvig Letters Serif for display headings, Geist for body)?
- Are `tabular-nums` applied to all financial/numeric data?
- Are shadcn/ui components used where appropriate, or are there custom implementations that should use shadcn?
- Are icon sizes consistent (15px nav, larger for empty states)?
- Are borders full-opacity `border-border` on cards/surfaces (no opacity-suffixed border classes like `border-border/60`)?

**Loading & Empty States**
- Does the page/component have a loading state? (skeleton, spinner, or shimmer)
- Is there an empty state when no data exists? (illustration, message, CTA)
- Are loading states using skeletons (preferred) rather than plain spinners?

**Error Handling UI**
- Are there error boundaries or error states shown to the user?
- Do forms show inline validation errors?
- Are error messages helpful and in Swedish?

**Animation & Motion**
- Are list items stagger-animated on entry?
- Do interactive elements have hover/active transitions?
- Are transitions using the project default (`transition-colors duration-150`) without spring/overshoot?
- Is `prefers-reduced-motion` respected?
- Are there abrupt state changes that would benefit from a transition?

**Accessibility**
- Do interactive elements have visible focus rings?
- Is color contrast WCAG AA compliant (4.5:1 text, 3:1 UI)?
- Is color never the sole indicator of state (paired with icons/text/shape)?
- Are form inputs labeled (via label element or aria-label)?
- Are clickable areas large enough for touch targets?

**Layout & Responsiveness**
- Does the layout work on mobile widths?
- Are tables horizontally scrollable on small screens?
- Is whitespace generous but not wasteful?
- Does dense data (tables, ledgers) use tighter but non-cramped spacing?

**Polish & Details**
- Are numbers right-aligned in tables?
- Are monetary values formatted consistently (Swedish format with kr)?
- Are dates formatted consistently?
- Are positive/negative amounts visually distinct?
- Are interactive elements obviously interactive (cursor, hover state)?
- Are disabled states visually clear?

## Step 3: Present Findings

After scanning, present findings as a numbered list. For each finding:

```
### #{number}: {Short title}

**Area**: {area name}
**File(s)**: {file path(s) with line numbers if relevant}
**Category**: {Consistency | Loading State | Error Handling | Animation | Accessibility | Layout | Polish}
**Severity**: {High | Medium | Low}

**What's wrong**: {1-2 sentences describing the current state}
**What it should be**: {1-2 sentences describing the desired state}
**Implementation notes**: {Brief technical guidance on how to fix it}
```

Sort findings by severity (High first).

After listing all findings, ask the user:
> "Found {N} design improvements. Create Linear tickets for: all, none, or specific numbers? (e.g., '1,3,5')"

## Step 4: Create Linear Tickets

For each approved finding, create a Linear issue using the `mcp__claude_ai_Linear__save_issue` tool with:

- **team**: `Gnubok`
- **title**: Short, actionable title prefixed with area. Example: `[Invoices] Add loading skeleton to invoice list`
- **description**: Markdown formatted:
  ```markdown
  ## Problem
  {What's wrong, current state}

  ## Proposed Change
  {What it should be, desired state}

  ## Implementation
  **File(s):** {file paths}
  **Category:** {category}

  {Implementation notes}

  ---
  *Generated by /scout-design*
  ```
- **labels**: `Improvement`
- **priority**: Map severity: High → 2, Medium → 3, Low → 4

After creating tickets, list them with their Linear identifiers so the user can reference them.

## Important Notes

- Be specific. "The button looks off" is not actionable. "The primary button in InvoiceForm uses `rounded-lg` while all other forms use `rounded-md`" is.
- Reference exact Tailwind classes, component names, and line numbers.
- Don't flag things that are intentional design choices documented in CLAUDE.md.
- Don't suggest adding features, only flag design/UX issues with what already exists.
- Keep findings focused on visual design, interaction design, and frontend polish. Not code quality or architecture.
- If a component is very small or trivial (e.g., a simple redirect page), skip it.
