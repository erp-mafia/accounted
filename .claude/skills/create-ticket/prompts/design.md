# Design Prompt

## Perspective

You are scanning for design and UX issues in the Accounted interface. The app follows an editorial-monochrome aesthetic: paper-white surfaces, hairline borders, serif headlines; considered and quiet. Evaluate against the Accounted design system: achromatic palette (semantic sage/ochre/terracotta are data-only: charts and financial deltas, never chrome), Hedvig Letters Serif display headings, Geist body, generous whitespace, functional (non-decorative) motion.

## Checklist

### Consistency & Design System
- [ ] Spacing values use Tailwind scale (not arbitrary values)
- [ ] Colors are from the design palette (grayscale, sage green, terracotta, ochre)
- [ ] Hedvig Letters Serif used for display headings, Geist for body text
- [ ] `tabular-nums` applied to all financial/numeric data
- [ ] shadcn/ui components used where appropriate
- [ ] Icon sizes consistent (15px nav, larger for empty states)
- [ ] Borders are full-opacity `border-border` on cards/surfaces (no `border-border/60`)

### Loading & Empty States
- [ ] Pages have loading states (skeletons preferred over spinners)
- [ ] Empty states exist with message and CTA when no data
- [ ] Loading states match the layout of the loaded content

### Error Handling UI
- [ ] Error boundaries or error states shown to the user
- [ ] Forms show inline validation errors
- [ ] Error messages are helpful and in Swedish

### Animation & Motion
- [ ] List items stagger-animate on entry
- [ ] Interactive elements have hover/active transitions
- [ ] Transitions use the project default (`transition-colors duration-150`): no spring/overshoot
- [ ] `prefers-reduced-motion` respected
- [ ] No abrupt state changes that need transitions

### Accessibility
- [ ] Visible focus rings on interactive elements
- [ ] WCAG AA contrast (4.5:1 text, 3:1 UI components)
- [ ] Color never sole indicator of state (paired with icons/text/shape)
- [ ] Form inputs labeled (label element or aria-label)
- [ ] Touch targets large enough

### Layout & Responsiveness
- [ ] Layout works on mobile widths
- [ ] Tables horizontally scrollable on small screens
- [ ] Whitespace generous but not wasteful
- [ ] Dense data uses tighter but non-cramped spacing

### Polish & Details
- [ ] Numbers right-aligned in tables
- [ ] Monetary values formatted consistently (Swedish format with kr)
- [ ] Dates formatted consistently
- [ ] Positive/negative amounts visually distinct
- [ ] Interactive elements obviously interactive (cursor, hover state)
- [ ] Disabled states visually clear

## Classification

- **Bug**: Broken layout, invisible text (contrast fail), non-functional interactive element, inaccessible form.
- **Feature**: Missing empty state, missing loading skeleton, missing responsive breakpoint, missing animation.
- **Improvement**: Inconsistent spacing, off-palette color, missing tabular-nums, hover state could be smoother, better icon choice.
