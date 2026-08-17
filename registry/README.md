# Community Registry

This directory is the source of truth for the registry shown at
[gnubok.se/community/registry](https://www.gnubok.se/community/registry):
skills, MCP servers, workflows and apps built on Accounted. The website syncs
its registry pages from here, so adding an entry is a normal pull request
against this repo.

## Structure

```
registry/
  entries/   one .mdx file per registry entry
  authors/   one .mdx file per author profile
```

Files starting with `_` are templates and are ignored by validation and sync.

## Adding an entry

1. Copy `entries/_template.mdx` to `entries/<your-slug>.mdx`. The filename is
   the slug and the public URL: `gnubok.se/community/registry/<your-slug>`.
2. If this is your first contribution, copy `authors/_template.mdx` to
   `authors/<your-handle>.mdx`. The `author` field in your entry must match an
   author file, so first-time contributors add both files in the same PR.
3. Validate locally: `npm run validate:registry` (or
   `npx tsx scripts/validate-registry.ts` without installing everything).
4. Open a PR. Commits need a DCO sign-off (`git commit -s`), same as the rest
   of the repo; see [CONTRIBUTING.md](../CONTRIBUTING.md).

A maintainer reviews the entry (does it work, does it describe itself
honestly, is the content safe) and merges. After merge the website pulls the
entry in with its registry sync; expect it live on the site within a few days
of merging.

## Entry frontmatter

Required:

| Field | Type | Notes |
|---|---|---|
| `title` | string | Shown as the card and page title |
| `description` | string | Card subtitle, max 500 chars; put detail in the body |
| `slug` | string | Must equal the filename |
| `kind` | `skill` \| `mcp` \| `workflow` \| `app` | Which shelf it goes on |
| `author` | string | Handle of a file in `authors/` |
| `status` | `live` \| `beta` \| `archived` | Be honest; `beta` is fine |
| `lang` | `sv` \| `en` | Language of the entry body |
| `personas` | list | Any of `founder`, `finance`, `byra`, `developer` |
| `publishedAt` | date | `YYYY-MM-DD` |
| `updatedAt` | date | `YYYY-MM-DD`, bump when you edit |

At least one of `installCommand`, `downloadUrl`, `repoUrl`, `externalUrl` is
required so readers can actually get the thing. Optional extras:
`featured` (maintainer-set), `oauthScopes`, `gnubokTools` (which MCP tools it
touches), `requiresWriteScope`, `sieCompatible`, `version`, `faq` (list of
`{q, a}`), `related` (list of slugs), `ogImageEyebrow`.

## Body rules

The body after the frontmatter is **plain Markdown** (headings, lists, tables,
links, fenced code blocks). The website renders bodies through MDX, which
evaluates raw tags (lowercase HTML included), `{...}` expressions and
`import`/`export` statements at build time, so the validator rejects all of
them. Fenced code blocks and backtick inline code are fine; they are
displayed, never executed. Need a literal `<tag>` or `{value}` in prose? Put
it in backticks.

Write the body like documentation, not a landing page: what it does, what it
needs (scopes, API keys), what it will not do, and one honest limitation
beats three superlatives.

## What gets accepted

- It must exist and work against Accounted today (the live app or the
  [MCP server](https://www.gnubok.se/community/registry/gnubok-mcp)).
- It must describe its write behavior truthfully. Anything that writes to the
  ledger goes through staged operations that a human approves; entries that
  work around that will not be listed.
- No fees are charged for listing, and your IP stays yours. Entries are
  documentation and are contributed under this repo's license; the thing the
  entry points to keeps whatever license you gave it.
