# License Compatibility, Copyleft, and High-Risk Triggers

This reference encodes the legal logic the scanner must apply when evaluating multi-license combinations and identifying high-risk licenses (AGPL, SSPL, BSL) that trigger consequences far beyond the standard copyleft model.

## OSADL FOSS License Compatibility Matrix

License compatibility is the framework that determines whether two licensed components can be combined and distributed together without contradiction. The Open Source Automation Development Lab (OSADL) maintains a machine-readable matrix that encodes pairwise compatibility for the major OSS licenses.

### Endpoints

Three JSON shapes from OSADL, choose by use case:

| Endpoint | Shape | Use |
|----------|-------|-----|
| `matrix.json` | Associative array `{outbound: {inbound: result}}` | Direct programmatic lookup by license pair. |
| `matrixseq.json` | Indexed array | Streaming or table generation. |
| `matrixseqexpl.json` | Indexed array with textual legal explanations | Human-readable PR comments and audit reports. |

Sync the matrix on a scheduled cadence (daily is sufficient) and pin the snapshot version in `.compliance/sources.lock`. Do not query OSADL on every PR scan.

### Result encoding

A pairwise lookup returns one of:

* **Compatible**: combination is permitted.
* **Incompatible**: combination violates one or both licenses; the matrix gives the contradiction reason in `matrixseqexpl.json`.
* **Conditional**: combination is permitted only if specific conditions are met (e.g., dynamic linking, system library exception). Requires reading the explanation field.

### Tooling

`flict` (FOSS License Compatibility Tool, Python) consumes the OSADL matrix directly and exposes:

* Compatibility verification across an entire dependency tree (input: SPDX SBOM).
* Candidate outbound license suggestion given a set of inbound licenses.
* Policy file evaluation: supply your organization's outbound license and a list of disallowed licenses; `flict` returns a verdict.

Wrap `flict` as a CI step rather than reimplementing matrix lookup logic in scanner code.

## FSF compatibility logic

The Free Software Foundation publishes the canonical compatibility tables for the GPL family. The scanner must encode the following:

### Permissive licenses

MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache 2.0 (with the patent-clause caveat below) are broadly compatible. Code under permissive licenses can be incorporated into copyleft-licensed projects, proprietary projects, and other permissively-licensed projects.

### GPL family

| Combination | Compatible? | Notes |
|-------------|-------------|-------|
| GPLv2-only + GPLv3 | **No** | Patent termination and indemnification differ. |
| GPLv2-or-later + GPLv3 | Yes | The "-or-later" allows promotion to GPLv3. |
| GPLv2-only + Apache 2.0 | **No** | Same patent-clause incompatibility. |
| GPLv3 + Apache 2.0 | Yes | GPLv3 was drafted to absorb Apache 2.0's patent clause. |
| GPLv3 + LGPLv2.1 | Yes | LGPLv2.1 is upgradable to GPLv3 via its `or-later` provision (when present). |
| GPLv3 + LGPLv3 | Yes | Designed to interoperate. |
| AGPLv3 + GPLv3 | Yes | AGPLv3 §13 explicitly allows linking with GPLv3. |

### LGPL nuance: linking model

The Lesser GPL is the only mainstream copyleft that allows proprietary code to use the LGPL component without the proprietary code becoming LGPL-licensed. The mechanism depends on linking:

* **Dynamic linking** (proprietary code calls LGPL library at runtime): proprietary code remains proprietary; user must be able to relink against a modified LGPL library.
* **Static linking** (LGPL library compiled into proprietary binary): proprietary code must allow the user to substitute a modified library, typically by shipping object files or statically linkable artifacts.

The scanner cannot determine link model from manifests alone. Surface the LGPL finding with a flag for human review of the build configuration, or use agentic reasoning over the `Makefile` / `CMakeLists.txt` / `Cargo.toml` link configuration.

### System library exception

GPLv2 and GPLv3 both contain a "system library" exception: a GPL-incompatible library that qualifies as a standard system component (libc, OS-shipped runtime libraries) can be linked with a GPL program without forcing source disclosure of that library. The scanner must not flag system-library combinations as violations; the dependency analyzer should classify these via known system-library lists.

## Copyleft contamination policy

If the scanner detects a strong copyleft license (GPL, AGPL, EUPL, OSL, CDDL with linking restrictions) in any dependency (direct or transitive) within a repository flagged for proprietary commercial distribution, the pipeline should:

1. Fail the build on the PR with a clear, specific error message naming the dependency, the license, and the contamination path.
2. Block the merge.
3. Generate a high-severity supply chain alert in the audit log.
4. Provide a remediation checklist: replace dependency, isolate as a separate process (microservice boundary), comply with the license, or seek a commercial alternative.

The contamination path is essential. A developer who imported a permissive package needs to see that the GPL dependency arrived via three transitive hops, not just that "something is GPL".

## AGPL Section 13: the network-use trigger

AGPL closes the "ASP loophole" left by traditional GPL. Standard GPL distribution triggers fire only on physical / binary distribution; SaaS providers historically argued that providing functionality over the network was not distribution. AGPL §13 contradicts this directly.

> "...if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network... an opportunity to receive the Corresponding Source of your version..."

Consequences if triggered:

* The full corresponding source of the modified AGPL component must be made available to every user who interacts with the running service over a network.
* "Corresponding source" includes scripts to control installation and modifications, per GPLv3 definition incorporated by reference.
* Internal proprietary backend code that has been combined with the AGPL component is potentially within the scope of "Corresponding Source": this is the contamination risk.

### Detection

* Static: any AGPL-licensed dependency in a repository deploying a network-facing service. Trigger an immediate critical finding.
* Agentic (see `agentic-prompts.md`): determine whether the deployment topology actually exposes the AGPL component over a network. Air-gapped, internal-only, or batch-processing deployments may not trigger §13. The agent reads `Dockerfile`, deployment manifests, ingress configuration, and architecture documentation to make the call.

### Resolution paths

* Replace the AGPL dependency with a permissively-licensed equivalent.
* Comply: publish the corresponding source.
* Air-gap: isolate the AGPL component in a process / service that has no network exposure to external users (often impractical).
* Negotiate a commercial dual-license with the upstream rightsholder (where offered).

## SSPL Section 13: service source code

The Server Side Public License v1.0 (MongoDB, October 2018) is AGPL-Section-13-on-steroids. SSPL §13 mandates that if the program's functionality is "made available to third parties as a service", the deployer must release the **Service Source Code**.

### Service Source Code definition

The SSPL definition is sweeping. It includes not only the licensed program but also:

* Management software
* User interfaces
* Application program interfaces (APIs)
* Automation software
* Monitoring software
* Backup software
* Storage software
* Hosting software

In practice this can pull the entire orchestration and operations stack of a SaaS deployment into scope.

### OSI status

The OSI did not approve SSPL as an open source license. Debian and Red Hat declined to package SSPL-licensed software as free software. Treat SSPL as **source-available**, not open source, in all internal documentation.

### Scanner behavior

* Flag SSPL components as highly restricted.
* Block introduction into any SaaS-facing build pipeline pending legal review.
* Do not auto-suggest SSPL replacements without confirming the consumer's distribution model.

## Business Source License (BSL) 1.1

The Business Source License is a source-available license designed to permit broad use while reserving "competitive offering" exclusions for the licensor. HashiCorp adopted BSL 1.1 in August 2023 (Terraform > 1.5.5, Vault, Consul, etc.).

### Mechanics

* Source is publicly readable and auditable.
* Use in production is permitted **except** as a "Competitive Offering".
* After a "Change Date" (typically four years), the work converts to a designated "Change License" (typically MPL 2.0 or Apache 2.0) and the BSL restrictions lift.

### Competitive Offering definition

A product or service sold to third parties that:

1. Provides similar functionality to the licensor's commercial offerings, **or**
2. Embeds the BSL-licensed work such that the offering requires it to operate.

### Why this is a hard call

Determining "competitive offering" requires evaluating:

* What the licensor sells commercially today.
* Whether the host application's functionality overlaps.
* Whether the BSL component is embedded vs. used as an internal tool.
* Whether the host application is sold to third parties at all.

This is not deterministic. The scanner detects the BSL component (deterministic); an agent evaluates the competitive-offering question (see `agentic-prompts.md` for the prompt template).

### Forks

Significant license-change events have spawned forks designed to preserve permissive licensing:

* **OpenTofu**: fork of Terraform, MPL 2.0, hosted under the Linux Foundation.
* **OpenBao**: fork of Vault, MPL 2.0.

Where a fork is viable and feature-complete, the cleanest resolution to a BSL finding is migration to the fork.

## License-change event registry

The scanner must encode the following historical license-change events. A dependency upgrade across one of these boundaries is automatically a high-severity finding.

| Project | Original | New | Change Date | Driver |
|---------|----------|-----|-------------|--------|
| MongoDB | AGPL | SSPL 1.0 | October 2018 | Block managed-service competitors. |
| Elasticsearch / Kibana | Apache 2.0 | Dual SSPL / Elastic License 2.0 | January 2021 | Block AWS Elasticsearch Service. |
| Elastic | SSPL/ELv2 | Added AGPLv3 (triple license) | August 2024 | Partial reversal; community pressure. |
| HashiCorp (Terraform, Vault, Consul, etc.) | MPL 2.0 | BSL 1.1 | August 2023 | Block competitive offerings; spawned OpenTofu, OpenBao. |
| Redis | BSD 3-Clause | Dual RSALv2 / SSPL 1.0 | March 2024 | Block managed Redis competitors; spawned Valkey (Linux Foundation). |
| Redis | RSALv2/SSPL | Added AGPLv3 | May 2025 | Partial reversal; ongoing fork dynamics. |

This registry ages. Always cross-check against the project's current license file at the version the scanner observes. A version-specific lookup is mandatory: MongoDB 3.6 is AGPL; MongoDB 4.0.3+ is SSPL. Treating MongoDB as a single license-bearing entity is wrong.

## Stack Overflow and CC-SA viral effect

Public Stack Overflow contributions are licensed CC BY-SA. Code copied from Stack Overflow into a proprietary codebase carries the share-alike obligation, which acts as a copyleft contamination vector. Up to a third of identified license conflicts in enterprise audits originate from Stack Overflow snippets. Snippet-level scanning (see `scanners-and-tooling.md`) is the only practical defense; relying on developer self-reporting is insufficient.
