# Output skill template

The generated skill is a folder:

```
<api-name>/
  SKILL.md            # conventions + endpoint index; under ~400 lines
  references/
    <group-a>.md      # full operation detail for one resource group
    <group-b>.md
    ...
```

## SKILL.md skeleton

```markdown
---
name: <api-name>
description: >-
  Consume the <API title> (<domain, e.g. "Swedish bookkeeping">, <base URL>).
  Use when building an integration or app against <API name>: <the 5-8
  resource nouns, e.g. "invoices, customers, payroll, reports">. Covers auth,
  conventions, and every endpoint.
---

# <API title> integration

<Two or three sentences: what the API is, what a consumer can do with it,
and the one thing that makes it different from a generic REST API.>

## Auth and base URL

<Auth header with exact format, where keys are created, test vs live keys,
scopes if any, rate limits. A copy-pasteable curl that lists something.>

## Conventions

<The cross-cutting rules, each with a one-line example where the shape is not
obvious: response envelope, pagination, error envelope + how to react to the
common codes, idempotency, dry-run, expansion, async patterns. This section
is why the skill exists; spend your effort here.>

## Endpoint index

<One line per operation, grouped. Each group heading names its reference
file: "Full detail: references/<group>.md". Line format:
`METHOD /path : summary [scope:x risk:y idempotent dry-run]`>

## Gotchas

<Only entries that are true and non-obvious: verified live mismatches,
sharp edges from the spec's own pitfall notes that apply across endpoints,
domain rules a generic developer would violate. No padding; delete this
section rather than fill it with restatements.>

## Verification

<Either: "Verified live on <date> against <base URL>: <what was called>."
Or: "Generated from spec, NOT yet verified live. Before first use run:
<smoke-test curl commands>.">
```

## references/<group>.md skeleton

```markdown
# <Group> endpoints

<One or two sentences: what this resource is and the state machine if any
(e.g. draft -> sent -> paid). Cross-reference sibling groups.>

<For each operation:>
### `METHOD /path`

**<Summary>.**
`scope:<s> · risk:<r> · idempotent · dry-run`

<Description from the spec, kept if it earns its lines: use-when,
do-not-use-for, pitfalls.>

<Parameters table if any beyond path ids.>

Request body:   (writes only)
```ts
{ condensed: "typescript-ish" }
```

Response `200`:
```ts
{ condensed: "typescript-ish" }
```

<For the 2-3 most-used operations in the group: a worked example with a
realistic request and a real (redacted) or spec-example response.>
```

## Quality checklist

Grade the generated skill against every item. Fix failures before delivering.

1. **First-call test**: could an agent with only SKILL.md (no references) make
   a correct authenticated list call? Auth format, base URL, and envelope must
   be sufficient.
2. **Trigger test**: does the frontmatter description name the API, its
   domain, and its resource nouns? An agent that has never seen this skill
   must match it from a prompt like "add <API> invoicing to our app".
3. **Coverage test**: every operation in the spec appears exactly once in the
   endpoint index, and every index group has a reference file.
4. **Restatement test**: does SKILL.md contain anything an agent would learn
   anyway from one endpoint call? Cut it.
5. **Convention test**: pagination, error handling, and idempotency are
   documented as rules, not repeated per endpoint.
6. **Honesty test**: every example response is real or clearly marked as
   spec-derived; the Verification section says what was and was not tested.
7. **Size test**: SKILL.md under ~400 lines; no reference file over ~700.
8. **Write-safety test**: destructive or high-risk operations are visibly
   marked so an agent knows to confirm before calling.
