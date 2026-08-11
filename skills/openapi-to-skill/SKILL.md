---
name: openapi-to-skill
description: >-
  Turn an OpenAPI/Swagger spec (JSON or YAML, file or URL) into an installable
  agent skill that teaches coding agents how to call that API correctly. Use
  when the user says "build a skill for this API", "generate a skill from this
  spec", "make our API docs agent-ready", or points at an openapi.json /
  swagger.yaml and wants an integration skill. Produces a SKILL.md +
  references/ folder ready for `npx skills add`.
---

# OpenAPI spec to agent skill

You are building a **consumer-side skill**: a folder of distilled instructions
that lets an agent integrate correctly against an API on the first attempt.
The output is NOT a restatement of the spec. A spec restatement grades D: the
agent could have read the spec itself. The value you add is selection
(what matters), compression (condensed schemas), conventions (the cross-cutting
rules), and verification (what the live API actually does).

## Inputs

Collect these before starting (ask only for what is missing):

1. **Spec location**: file path or URL. If URL, download it next to your work.
2. **Output directory**: `skills/<api-name>/` in the repo when the skill will
   be distributed (installable via `npx skills add owner/repo --skill <api-name>`),
   `.claude/skills/<api-name>/` when it is for personal/project use only.
3. **Credentials for verification** (optional but strongly preferred): a base
   URL and an env var holding a low-privilege or test API key. Read-only
   verification only; never call write endpoints without explicit user consent.

## Process

### 1. Inventory the spec

Run the bundled tool (portable, stdlib-only Node):

```bash
node scripts/openapi-inventory.mjs <spec.json>              # overview: groups + one line per operation
node scripts/openapi-inventory.mjs <spec.json> --group <g>  # full detail for one group
```

YAML specs: convert first (`npx -y js-yaml spec.yaml > spec.json`).

The overview gives you: title, servers, auth schemes, operation count, and
operations grouped by tag (or by dominant path segment when the spec has no
tags). Read it fully before writing anything.

### 2. Extract the conventions

The conventions section is the most valuable part of the output skill: it is
what lets an agent predict endpoint behaviour instead of looking everything up.
Hunt for them in this order:

- `info.description`: many agent-first APIs state their invariants here.
- `components.securitySchemes`: auth header shape, token format, where keys
  come from (docs often say; if not, ask the user).
- Recurring response envelope: sample 3-4 operations with `--group` and
  compare. Note pagination style (cursor vs offset), error envelope, request
  id fields.
- Recurring parameters and headers: idempotency keys, dry-run flags, expand
  parameters, rate limits.
- `x-*` extensions: risk levels, scopes, idempotency markers. Surface them;
  they exist for agents.

If the spec is thin on conventions, check the API's human docs (ask the user
for the docs URL) rather than guessing.

### 3. Choose the reference grouping

Target 6 to 12 reference files. Merge tiny groups thematically (e.g.
`customers` + `articles` into `invoicing`); split any group that would exceed
roughly 500 lines rendered. Every operation must land in exactly one
reference file.

### 4. Write the skill

Follow `references/output-template.md` for the exact shape. Non-negotiables:

- **SKILL.md stays under ~400 lines.** Frontmatter description must name the
  API and its domain so the skill triggers (the agent sees only name +
  description at discovery time).
- **Conventions before endpoints.** Auth + base URL + envelope + pagination +
  error handling first; the endpoint index after.
- **Endpoint index**: one line per operation (`METHOD path : summary [badges]`),
  grouped, each group naming its reference file. The inventory tool's overview
  output is already in this format.
- **References**: start from `--group` output, then edit. Deduplicate
  boilerplate the spec repeats per operation (shared error lists, envelope
  wrappers) up into the conventions section, keep operation-specific pitfalls
  inline, and add a worked example (request + realistic response) for the 2-3
  most-used operations per group.
- **Schemas in condensed TypeScript-ish form**, never raw JSON Schema.

### 5. Verify against the live API

This step separates a usable skill from a plausible-looking one. Desk review
and live testing find different failure classes.

With credentials: smoke-test read-only endpoints (health/list endpoints, one
or two per group), using the exact auth header the skill documents. Compare
actual responses against the documented envelope and schemas. Every mismatch
is gold: record it in a **Gotchas** section in SKILL.md. Replace invented
examples with real (redacted) response bodies.

Without credentials: add a **Verification** section stating the skill was
generated from the spec and not yet tested live, with the smoke-test commands
a future session should run once a key exists.

### 6. Grade it

Score the output against the checklist at the bottom of
`references/output-template.md`. Fix what fails, once. Then report to the
user: what was generated, what was verified live vs. desk-only, and how to
install it (`npx skills add <owner>/<repo> --skill <name>`).

## Anti-patterns

- Restating the spec operation-by-operation with no selection or added
  operational knowledge.
- Raw JSON Schema dumps, or full request/response schemas for every endpoint
  when a condensed form plus one worked example carries more information.
- Auth buried mid-file. It is always the first section after the intro.
- Inventing example responses when a live call could have produced a real one.
- A giant single SKILL.md instead of progressive disclosure via references/.
- Skipping the grade step because the output "looks complete".
