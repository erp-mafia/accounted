# Documentation

Start with the [user and API documentation](https://docs.accounted.se) for using Accounted. This directory explains how to understand, develop, operate, and extend the project.

## Find your starting point

| I want to... | Start here |
| --- | --- |
| Run Accounted myself | [Self-hosting](SELF-HOSTING.md) |
| Understand the system | [Architecture](architecture.md) |
| Contribute a change | [Contributing](../.github/CONTRIBUTING.md) |
| Connect Claude Code | [Accounted plugin](../packages/claude-plugin/README.md) |
| Build an integration | [Public API](https://docs.accounted.se), [API skill](../skills/accounted-api/SKILL.md) |
| Build an extension | [Extension development](EXTENSIONS.md) |
| Report a vulnerability | [Security policy](../.github/SECURITY.md) |

## Architecture and domain

- [Source directory](../src/README.md): application modules and import conventions.
- [Reference materials](reference/README.md): taxonomy inputs and official report examples.
- [Architecture](architecture.md): accounting engine, tenancy, extensions, events, and agent access.
- [Glossary](glossary.md): white-label brands, teams, home domains, and shared terminology.
- [Legal forms](LEGAL-FORMS.md): capability profiles and the cross-surface support contract.
- [White-label setup](WHITELABEL.md): branding and partner configuration.
- [Peppol foundation](PEPPOL_FOUNDATION.md): e-invoicing integration design.
- [Bookkeeping packs](../packs/README.md): reusable template data and validation.

## Hosting and operations

- [Self-hosting](SELF-HOSTING.md): complete setup and upgrade guide.
- [Docker reference](DOCKER.md): image, Compose overlays, and runtime configuration.
- [Swedish infrastructure](SOVEREIGN.md): hosting and provider choices.
- [SIE import operations](operations/sie-import-backbone.md): import jobs and recovery.
- [Provider migration jobs](operations/provider-migration-jobs.md): worker operation and limits.
- [Repository scripts](../scripts/README.md): generators, validation, and operational tools.

## Security and policies

- [Vulnerability reporting](../.github/SECURITY.md).
- [Privileged RPC authorization](security/authorization-policy.md): database-operation access contracts.
- [Authentication abuse protection](security/auth-abuse-protection.md).
- [Logging and observability](security/logging-and-observability.md).

## Community

- [Community registry](../registry/README.md): contribute a skill, MCP server, workflow, or app.
- [Code of conduct](../.github/CODE_OF_CONDUCT.md).

Agent contributors should start with [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md). Keep setup commands in the hosting guides and architectural rules in their source documents; link to them instead of maintaining duplicate instructions.
