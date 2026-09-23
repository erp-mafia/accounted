# Application source

The Next.js application and its supporting modules live here. Import application code with `@/`, which resolves to this directory.

| Directory | Purpose |
| --- | --- |
| `app/` | Pages, layouts, API routes, and global styles |
| `components/` | Shared interface components |
| `contexts/` | Client context providers |
| `extensions/` | Opt-in product extensions |
| `i18n/`, `messages/` | Locale setup and Swedish/English translations |
| `lib/` | Accounting engine, domain services, integrations, and shared utilities |
| `types/` | Shared TypeScript types |

`proxy.ts`, `instrumentation.ts`, and `instrumentation-client.ts` are Next.js entry points. Unit tests remain alongside the code they cover; [tests/](../tests/) holds shared helpers and database suites.

Run development, builds, tests, and generators from the repository root. Configuration, environment files, public assets, database migrations, and installation commands remain there. See the [architecture guide](../docs/architecture.md) for module boundaries and the [contributing guide](../.github/CONTRIBUTING.md) for the development workflow.
