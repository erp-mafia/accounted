# SPDX, REUSE, NOTICE: Detection and Attribution Reference

The deterministic detection layer of any OSS compliance scanner rests on the SPDX License List and adjacent attribution conventions. This reference defines the canonical inputs, the matching rules, and the structural checks that scripts must perform.

## SPDX License List framework

### Repository topology

Two repositories under the SPDX organization, with distinct roles:

* **`spdx/license-list-XML`**: the governance and authoring repository. Contains the source XML schema for every license and exception. Maintained by the SPDX Legal Team. Do **not** parse this directly from a scanner; the XML is structured for human curation, not machine evaluation.
* **`spdx/license-list-data`**: the downstream distribution repository. Compiled from `license-list-XML` into stable machine-readable formats: JSON, RDFa, HTML, plaintext. This is what the scanner ingests.

Both repositories release under semantic versioning tags (`vX.Y` or `vX.Y.Z`). Pin to a specific release in `.compliance/sources.lock` so two runs of the scanner against the same commit always evaluate against the same license catalog.

### JSON ingestion

Pull two arrays from `license-list-data`:

* `licenses.json`: every active and deprecated license entry.
* `exceptions.json`: every license exception (e.g., `Classpath-exception-2.0`, `LLVM-exception`, `Autoconf-exception-2.0`).

Per-entry fields the scanner must consume:

| Field | Purpose |
|-------|---------|
| `licenseId` | Standardized short identifier. ASCII, letters / digits / `.` / `-` only. The matching key. |
| `name` | Formal legal title, normalized (version abbreviations stripped from sort name). |
| `licenseText` / `standardLicenseTemplate` | Full prose; the diff target for full-text matching. |
| `seeAlso` | Canonical permanent URLs. |
| `isOsiApproved` | Boolean. OSI-approved → safe baseline for "open source" declarations. |
| `isFsfLibre` | Boolean. FSF-recognized free software license. |
| `isDeprecatedLicenseId` | Boolean. Deprecated identifiers still resolve but should be flagged for migration. |

Boolean gates compose into deterministic policy: e.g., fail the PR if any newly introduced direct dependency has `isOsiApproved == false` and is not on an explicit allow list.

## SPDX matching guidelines

License texts in the wild differ from canonical text by typography, formatting, copyright placeholders, and trivial wording variants. The SPDX Matching Guidelines define what differences are tolerable.

### Markup attributes

The XML schema marks regions of license text with attributes that the matcher must respect:

* **Omittable text**: visually styled blue in HTML; tagged via `altParagraphType` in the XML. Can be absent from a candidate without disqualifying the match. Common for optional preambles or address blocks.
* **Replaceable text**: visually styled red in HTML; represents fields like copyright holder name, year, project title. The matcher must capture these via wildcard / placeholder logic, not literal matching.

### Equivalent words

`equivalentwords.txt` in the SPDX repository catalogs spelling variants of legally significant terms (British vs American English: `licence`/`license`, `merchantability` variants, etc.). The matcher must treat listed variants as equivalent.

### Implementation

Do not write the matcher from scratch. Use ScanCode Toolkit, which embeds the full SPDX matching logic with 30,000+ regression tests. Scanner-author energy is better spent on the orchestration and policy layers.

## SPDX License Expressions

A single component may declare a compound license. The expression syntax must be parsed correctly.

### Operators

* `OR`: disjunction. `(MIT OR Apache-2.0)` means the consumer chooses one. The scanner must record the **chosen** license; an unresolved `OR` is a finding requiring agentic resolution or `.ort.yml` curation.
* `AND`: conjunction. All terms apply simultaneously.
* `WITH`: appends a standardized exception. `GPL-2.0-only WITH Classpath-exception-2.0` means GPLv2 with the linking exception. Look up the exception in `exceptions.json`.
* `+`: "or any later version". `GPL-2.0+` means GPLv2 or any later GPL. Operationally this is dangerous: future GPL versions cannot be evaluated for compatibility today, so policy should treat `+` as a flag for review.

### Suffixed identifiers

The SPDX list distinguishes `GPL-2.0-only` from `GPL-2.0-or-later`, `LGPL-3.0-only` from `LGPL-3.0-or-later`, etc. Older expressions (`GPL-2.0`) are deprecated; the scanner should normalize to the explicit `-only` / `-or-later` form and warn on the legacy bare identifier.

## Apache 2.0 NOTICE requirements

Apache 2.0 §4(d) is the most commonly violated attribution clause in commercial distributions. The scanner must enforce it explicitly.

### Required artifacts

For any distribution that includes Apache 2.0 components:

1. The Apache 2.0 license text in a `LICENSE` file at the top of the distribution.
2. A `NOTICE` file containing every upstream attribution notice, **carried forward unchanged** even if the consuming project modifies the underlying source. Modification is allowed; stripping is not.
3. The `NOTICE` file must contain only legally required notices. Marketing copy belongs elsewhere.

### What does not count

Git commit messages, commit timestamps, and authorship metadata are **not** attribution under §4(c). The legal artifact is the file content, not the version control history. A scanner that says "the author is in the commit log" is wrong.

### Scanner check

For every Apache 2.0 dependency identified by the analyzer, the scanner should:

1. Fetch the upstream `NOTICE` content (from the resolved package source, not from a third-party mirror).
2. Verify the local `NOTICE` file contains those lines. Truncated or stripped NOTICE content is a finding.
3. If the project modifies the dependency, verify the modification statement required by §4(b) is present.

## REUSE specification

The REUSE specification (FSFE) makes file-level license attribution machine-readable, eliminating ambiguity from the matcher entirely. A REUSE-compliant repository is the highest-confidence target for automated scanning.

### Conformance conditions

The `reuse` linter checks three things:

1. **Bulk metadata**: `REUSE.toml` (current spec) or `.reuse/dep5` (legacy DEP-5 syntax) for directories where per-file headers are impractical (assets, generated files).
2. **File-level identifiers**: every source file carries a header comment with `SPDX-FileCopyrightText:` and `SPDX-License-Identifier:` lines. Format depends on the file's comment syntax.
3. **License texts**: `LICENSES/` directory at the repository root containing the unaltered text of every license referenced anywhere in the codebase.

### Enforcement integration

Run the `reuse` linter in CI as a separate step from the SCA scan. On non-conformance, the scanner can auto-generate a PR comment with the missing SPDX header lines for each file, formatted as a suggested edit. This converts a tedious legal task into a one-click developer action.

### When REUSE is overkill

REUSE conformance is a high bar for older codebases. If a repository ships only a single license throughout, full REUSE may produce header noise without compliance gain. A pragmatic baseline: REUSE for new files, bulk metadata covering legacy directories, root `LICENSES/` always populated.

## Common detection failure modes

Patterns that produce false negatives in naive scanners:

* **License in subdirectory**: Many projects place `LICENSE.txt` next to `README.md` in a subdirectory rather than the repo root. Recursive scanning is required.
* **License inside header comment**: Some projects (especially smaller libraries) embed the entire license in a top-of-file comment with no separate `LICENSE` file.
* **License by reference**: A `README.md` line "Licensed under MIT" with no actual license text. Scanner should detect the reference but flag the missing canonical text.
* **Dual-licensed files with single header**: A file declaring `SPDX-License-Identifier: MIT OR Apache-2.0` is dual-licensed; downstream choice must be recorded, not silently defaulted.
* **License changed mid-repo**: A package that flipped license between versions (Redis pre/post 7.4, Elastic pre/post 7.11) requires version-specific resolution. Lockfile-based version pinning is the input; the scanner must not default to `HEAD`.
