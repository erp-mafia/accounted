# Modifier atoms

Cross-cutting attributes that aren't an industry on their own but change how
the agent interprets the company. The composer can pick several modifiers
per company.

```
.claude/skills/modifier/
├── README.md                          ← this file
├── single-shareholder-ab-fmb/
│   └── SKILL.md
├── enskild-firma/
│   └── SKILL.md
└── small-employer/
    └── SKILL.md
```

## When to author a modifier vs. a vertical

- **Vertical** = what the company *does* (restaurang, e-handel, konsult-IT).
- **Modifier** = a structural attribute (form, ownership, employer status,
  multi-currency, blandad verksamhet, …).

A company will typically have **0-1 vertical** and **0-3 modifiers**.

## Authoring contract

Same SKILL.md + YAML frontmatter as `industry/` atoms, but `tier: modifier`
and no `sni_prefixes`:

```yaml
---
id: modifier/<slug>
tier: modifier
title: "Display name"
description: >
  One paragraph the composer reads when deciding whether to load this.
  Cover the qualifying conditions (e.g. "AB med en aktieägare") and the
  most distinctive accounting implications.
trigger_signals:
  ownership: "single_shareholder"
  bas_account_patterns: ["2898", "2899"]
estimated_tokens: 6000
version: 1
---
```

## Suggested body sections

1. **When this applies**: the precise conditions the agent should look for.
2. **Implications**: what changes in day-to-day bookkeeping.
3. **Regulatory edge cases**: laws that fire because of this modifier.
4. **BAS account patterns**: accounts that show up because of it.
5. **References**: links to horizontals and into `references/*.md` files.

## Adding / removing

Same workflow as `industry/`: write the SKILL.md, run
`npx tsx scripts/seed-agent-atom-registry.ts`. Set `is_active: false` to
deprecate.
