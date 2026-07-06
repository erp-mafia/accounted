# Violation Patterns and Legal Precedents

What developers believe is in the codebase rarely matches what is actually there. This reference catalogs the failure modes that produce real legal exposure and the precedents that demonstrate the consequences are not theoretical.

## Code-level violations

### Hidden licenses and Gist contamination

The default developer assumption ("no LICENSE file means public domain") is wrong. Licenses appear in:

* Subdirectories rather than the repository root.
* Top-of-file header comments rather than separate license files.
* References from `README.md` to a separately-hosted license file.
* Author profile pages that apply a blanket license to all of the author's public code.

**Pattern**: a developer copies code from a GitHub Gist (no license file in the Gist itself), pastes it into the proprietary codebase, and ships. The Gist author maintains a separate Gist stating "all my Gists are licensed under X11"; that license now applies to the copied code, attribution is missing, and the proprietary distribution is in violation.

The scanner's defense is snippet matching against the public Gist corpus, plus a hard policy that any uncommented multi-line block introduced without a corresponding manifest change triggers snippet scanning.

### Stack Overflow CC BY-SA contamination

All publicly-posted Stack Overflow code is licensed CC BY-SA (Creative Commons Attribution-ShareAlike). The share-alike obligation means:

* Derivative works must carry the same license.
* Attribution is required.

In a proprietary codebase, this functions as a copyleft contamination vector. Enterprise audits routinely find that 20-33% of identified license conflicts trace to Stack Overflow snippet pasting.

The scanner's defense is the same: snippet matching against the Stack Overflow code corpus.

### AI-generated code and snippet reproduction

The 2022 class action (`DOE 1 et al. v. GitHub, Inc., Microsoft Corporation, OpenAI`) alleged that Copilot reproduces copyrighted code snippets in violation of DMCA §1202 and the underlying open source licenses, by stripping attribution and copyright notices.

The legal status of AI-generated code that matches training-corpus snippets remains unsettled. Conservative scanners should:

* Treat AI-generated commits the same as any other code: snippet-match against the public corpus.
* Surface high-confidence matches for review regardless of whether the developer "wrote" or "generated" the code.

The risk is that AI-emitted code reproduces a GPL or AGPL snippet verbatim, the developer believes the code is novel, and ships it into a proprietary distribution.

## Configuration- and dependency-level violations

### Transitive copyleft

The dominant pattern. A team explicitly approves a permissively-licensed dependency (Apache 2.0, MIT). Buried in the dependency tree, a transitive dependency carries GPL or AGPL.

A scanner that only reads top-level manifests (`package.json`, `pom.xml` direct declarations) misses this. Real risk requires a full dependency-tree resolution.

The ORT analyzer is the right tool: it resolves the full transitive graph per-ecosystem and exposes contamination paths.

### Lockfile drift

A dependency that was permissively licensed at the version pinned in `package-lock.json` may have flipped license at a later version. A `npm audit fix` or `npm update` can pull the new version without manifest change. The scanner must run on lockfile changes, not only on `package.json` changes.

### Submodule / vendored code

Git submodules and vendored copies sit in the repository but escape manifest-based dependency resolution. Walk every directory tree with the source-level scanner (ScanCode), not just declared dependencies.

### Unsupported / abandoned upstreams

A dependency whose upstream is dead may be license-clean today but accumulating CVEs and lacking the maintainer to relicense or fix. The compliance program must surface "license-clean but operationally risky" as a separate signal from license findings, but the same scanner data feeds both.

## Distribution-model contamination

### SaaS exposure of AGPL components

Standard pattern: a development team adds an AGPL dependency for a useful feature, builds it into the backend of a customer-facing SaaS application, and ships. AGPL §13 is now triggered: every user interacting with the service has a right to the corresponding source.

The "corresponding source" potentially includes proprietary code that has been combined with the AGPL component. The scope is ambiguous and contested but always large enough to warrant blocking the merge before the contamination ships.

### "Internal tool" misclassification

A team treats an AGPL- or SSPL-licensed tool as "internal use only": exempt from §13 because no external users interact with it. The classification holds **only** if the deployment is genuinely internal:

* No external customers, partners, or contractors interact with it over a network.
* The "service" is not exposed via VPN, partner API, or shared infrastructure.

In practice, "internal" creeps. A tool deployed as internal becomes externalized when integrated with a customer-facing product. The scanner should require explicit opt-in classification per deployment, with periodic re-validation.

## Legal precedents

### Orange S.A. v. Entr'ouvert (Paris Court of Appeal, February 2024)

Orange, a major telecommunications carrier, was ordered to pay **€800,000 in damages** to Entr'ouvert for distributing modified Lasso software (GPLv2) without releasing the corresponding source code.

Notable features:

* **€150,000 of the award was moral damages**: a French legal concept, but a clear signal that courts treat OSS licensing violations as more than contractual breach.
* The case originated in 2005 and litigated for nearly two decades. Compliance programs that assume "no one will sue" are betting against a 20-year time horizon.
* The defendant was a sophisticated commercial entity, not a hobbyist; sophistication did not mitigate liability.

### GitHub Copilot class action (US, 2022-ongoing)

`DOE 1 et al. v. GitHub, Inc., Microsoft Corporation, OpenAI`, Northern District of California. Plaintiffs allege Copilot reproduces licensed code without preserving attribution or licensing terms. Theories include DMCA §1202 (removal of copyright management information), open-source license breach, and tortious interference.

The case is a useful signal regardless of outcome: it establishes that AI-emitted code is not a legal blank slate. Conservative compliance programs assume AI-generated code carries the same scrutiny burden as human-written code.

### SCO v. IBM (lessons on license source uncertainty)

Older precedent, but the relevant lesson is durable: a vendor that distributes code without authoritative provenance records exposes itself to claims it cannot easily refute. The scanner's audit trail (commit-pinned scan output, reasoning logs, suppression justifications) is the artifact that lets a defendant respond definitively.

## Patterns that survive scanner coverage

These patterns evade purely automated detection. Document them and feed them into agentic review:

* **Renamed and refactored snippets**: sufficient transformation evades fingerprint matching but may still be derivative.
* **License declared in commit message only**: has no legal force; the file content governs.
* **License declared in pull-request body**: same; the merged file content governs.
* **License inferred from project context**: "the rest of this repo is MIT, so this file is too" is not a license. SPDX header per file is the clean answer.
* **License changed in upstream upstream**: a transitive of a transitive flipped license; the lockfile pin protected you, until the next dependency update.

## Internal organizational patterns

Compliance programs fail more often from process gaps than scanner gaps:

* No designated owner of the OSS policy. Findings have nowhere to go.
* No legal-engineering interface. Engineers triage license findings as bugs; lawyers never see the hard cases.
* No M&A pre-flight check. The first comprehensive audit happens during diligence, when remediation is most expensive.
* No supplier flow-down. Outsourced development produces deliverables that have never been scanned, because the contract did not require it.

The skill's output (SBOM, audit log, triaged violation report) is the input to fixing these gaps; the gaps themselves are out of scope for the scanner.
