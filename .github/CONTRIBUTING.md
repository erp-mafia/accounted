# Contributing to Accounted

Thank you for your interest in contributing to Accounted. This guide covers the development workflow, coding standards, and submission process.

Everyone interacting in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repository and clone your fork
2. Install dependencies: `npm install`
3. Start a local backend and the dev server: `npm run local:up` (see [Supabase Setup](#supabase-setup))
4. Run tests: `npm test`

## Supabase Setup

The app runs on a Supabase backend. You do not need a Supabase account for one: with Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development) installed, one command starts it on your machine.

```bash
npm run local:up     # prints the URL to open and the login to use
npm run local:down   # stops it and deletes its data
```

`local:up` starts a Supabase stack of its own for this checkout, applies `supabase/bootstrap.sql` and every migration, creates a user and a company, and starts the dev server on a free port. The dev server gets the local stack's URL and keys and no provider, mail or analytics key. It refuses to start in a checkout that has a `.env`, `.env.local` or `.env.development` file, because the dev server would load the keys in them. `npm run local:up -- --sim` also builds a company with three years of example books.

To use a Supabase project of your own instead:

1. Create a free project at [supabase.com](https://supabase.com)
2. Run `supabase/bootstrap.sql` once, then all migrations from `supabase/migrations/` in filename order (see [docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md#3-apply-database-migrations); a project created since 2026-05-30 answers every request with 42501 if the bootstrap is skipped)
3. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Start the dev server: `npm run dev`

## Development Workflow

1. Create a branch from `main` with a descriptive name
2. Make your changes following the code style below
3. Run the full check suite before submitting:

```bash
npm run lint
npm run check:types    # npm test does not type-check
npm run check:guards   # ratchet guards; each failure prints its fix
npm test
npm run build
```

   CI also checks that generated files are current (`skills:check`, `taxonomy:check`, `apiskill:check`, `notice:check`) and validates `packs/` and `registry/`; each prints the command that regenerates it.

4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature
   - `fix:` bug fix
   - `refactor:` code restructuring
   - `test:` adding or updating tests
   - `docs:` documentation changes

## Contributor License Agreement

Before we can merge your first pull request, you sign the [Accounted Contributor License Agreement](../CLA.md) once. The CLA Assistant bot posts a link in the pull request, and you accept the agreement there with your GitHub account.

The agreement is a licence, not a transfer: you keep the copyright in your work. It lets Arcim Technology AB offer the project under other licences too, and Arcim promises that every contribution stays available under an open-source licence. If you contribute for a company, write to support@accounted.se first.

Contributions merged before the agreement was introduced were made under the [Developer Certificate of Origin](DCO), which still applies to them. Signing off commits with `git commit -s` is still welcome.

## Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what and why
- Ensure CI passes (the core build resets extensions to empty, so core code must compile standalone)
- Link related issues if applicable

## AI-Assisted Contributions

You may use AI tools (coding agents, chat assistants, completion) to prepare a contribution. These rules apply to every pull request made with their help:

- **Disclose it.** Say in the pull request which tools you used and for what; the pull request template has a checkbox for it.
- **A human author is accountable.** You have read every line you submit, understand it, can explain it in review, and answer for it as your own work.
- **Small, focused pull requests with tests.** One change per pull request, with tests for new or changed logic (the Definition of Done in [CLAUDE.md](../CLAUDE.md) lists them).
- **No bulk or autonomous agent pull requests from outside contributors.** A person drives every pull request; an agent does not open pull requests on its own, and one issue does not become a batch of generated pull requests.
- **At most 3 open pull requests per outside contributor.** Open the next one when an earlier one is merged or closed.
- **The CLA applies** to AI-assisted work like any other; section 6 of the [CLA](../CLA.md) covers material produced with an AI tool.

Pull requests that do not follow these rules may be closed without review. Agents working in this repository read [CLAUDE.md](../CLAUDE.md) or [AGENTS.md](../AGENTS.md).

## Extension Development

See the [architecture guide](../docs/architecture.md) and [extension guide](../docs/EXTENSIONS.md) for the full extension architecture. Quick start:

```bash
npx tsx scripts/create-extension.ts --name my-ext --sector general --category operations --description "..."
```

Then add `"my-ext"` to `extensions.config.json` and run `npm run setup:extensions`.

Constraints:
- Extensions cannot use dynamic imports (Next.js bundling requirement)
- Core must build and run with zero extensions enabled
- Never import from `@/extensions/` in core code

## Community Registry

The registry at [accounted.se/community/registry](https://www.accounted.se/community/registry) (skills, MCP servers, workflows and apps built on Accounted) is sourced from the [`registry/`](../registry/) directory in this repo. To list something you built, add an MDX entry there by PR; see [registry/README.md](../registry/README.md) for the format and run `npm run validate:registry` for the local check. No code changes needed.

## What Not to Do

- **Don't modify enforcement triggers** in migration 017 (legally required for Swedish accounting law)
- **Don't insert directly into journal tables**: use the engine functions in `src/lib/bookkeeping/engine.ts`
- **Don't break the core/extension boundary**: core must compile standalone without extensions
- **Don't edit or delete posted journal entries**: correct them by storno (`reverseEntry()`, `correctEntry()`) or the inline rättelse RPCs

## Code Style

- TypeScript strict mode, no `any` unless unavoidable
- English for all code, comments, and commit messages
- `roundOre()` from `src/lib/money.ts` for monetary rounding, never `toFixed()` or a hand-rolled `Math.round(x * 100) / 100`
- Account numbers are strings (`'1930'`, not `1930`)
- All shared types go in `src/types/index.ts`

## Questions?

Open an issue on GitHub. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
