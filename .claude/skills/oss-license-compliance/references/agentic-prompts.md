# Agentic Prompts for Ambiguous License Evaluation

The deterministic scanner identifies the presence of a high-risk license. It cannot determine whether the legal trigger of that license actually fires, because the trigger depends on facts about the host application that no manifest exposes. This reference provides prompt templates for the agentic auditor that resolves these cases.

## Operating principles

1. **The agent does not replace the scanner.** The scanner produces the deterministic finding ("MongoDB 6.0 is SSPL"); the agent answers the qualitative question ("does our deployment trigger §13").
2. **Output is structured.** Every prompt requires a JSON response so downstream tooling (ORT, the violations report, the audit log) can consume it.
3. **Reasoning is logged.** The prompt, model identifier, input file hashes, and full output are persisted to a tamper-evident audit trail keyed by commit SHA. The agent's reasoning becomes the verifiable artifact, not the model output alone.
4. **Conservatism is the default.** When evidence is ambiguous, the agent returns `is_compliant: false` with `confidence: low` and a request for human review. Optimistic defaults compound legal risk silently.
5. **Scope is bounded.** The agent reads only the files explicitly provided in the prompt. It does not browse the web, query external APIs, or infer facts not present in the inputs.

## Prompt template: AGPL §13 network-use evaluation

**When to invoke**: scanner has identified a direct or transitive AGPLv3 dependency in a repository that may deploy a network-facing service.

**Inputs to provide**:
* The dependency tree path showing how the AGPL component arrived.
* The repository's `Dockerfile`, `docker-compose.yml`, `kubernetes/` manifests, ingress configuration, deployment manifests.
* The repository's `README.md` and any `architecture.md` / `ARCHITECTURE.md`.
* The license text of the AGPL component.

**Prompt**:

> You are evaluating whether the AGPLv3 §13 ("Remote Network Interaction") trigger applies to a specific deployment of an AGPL-licensed component within the host repository whose files are attached.
>
> AGPLv3 §13 states that if the program is modified and the modified version is "interacted with remotely through a computer network", the operator must offer all interacting users the opportunity to receive the corresponding source code of the modified version.
>
> Evaluate three factual questions, in order:
>
> 1. **Modification**: Is the AGPL component modified by the host repository? Inspect any patches, monkey-patches, forks, configuration that overrides component behavior, or build steps that alter the component's source. Report yes / no / uncertain with evidence (file paths and excerpts).
> 2. **Network interaction**: Does the deployed application allow users to interact with the AGPL component remotely through a computer network? Inspect ingress configuration, exposed ports, public DNS records, deployment topology. Internal-only deployments behind a corporate VPN with no external user access do **not** trigger §13. SaaS deployments with external users **do** trigger §13. Air-gapped batch jobs **do not** trigger §13. Report yes / no / uncertain with evidence.
> 3. **User interaction with modified version**: Does the user's network interaction reach the modified portion of the AGPL component, or only unmodified portions? This is a narrower question than §13's literal text and conservative analysis treats any reachable modified code as triggering. Report yes / no / uncertain with evidence.
>
> Output a JSON object exactly matching this schema:
>
> ```json
> {
>   "modification": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "network_interaction": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "modified_code_reachable": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "section_13_triggers": true|false,
>   "confidence": "high|medium|low",
>   "recommended_action": "...",
>   "human_review_required": true|false
> }
> ```
>
> If any of the three sub-questions is `uncertain`, set `human_review_required` to `true` and `confidence` to `low`. The cost of false negatives in this domain (failing to detect a triggered §13) far exceeds the cost of false positives (escalating an untriggered case). Bias accordingly.

## Prompt template: SSPL §13 service-source-code evaluation

**When to invoke**: scanner has identified an SSPL-licensed component (MongoDB ≥ 4.0.3, Elasticsearch 7.11-7.16 / 7.16+ partial, Redis ≥ 7.4 dual SSPL, etc.) in a repository that may offer the component's functionality as a service.

**Inputs to provide**: same as AGPL template, plus the Service Source Code definition language from SSPL §13.

**Prompt**:

> You are evaluating whether the SSPL v1.0 §13 ("Offering the Program as a Service") trigger applies to a specific deployment of an SSPL-licensed component within the host repository whose files are attached.
>
> SSPL §13 states that if the functionality of the SSPL-licensed program is "made available to third parties as a service", the operator must release the **Service Source Code** under SSPL. The SSPL definition of Service Source Code is sweeping and includes the program plus management software, user interfaces, application program interfaces, automation software, monitoring software, backup software, storage software, and hosting software used to make the service available.
>
> Evaluate three factual questions, in order:
>
> 1. **Service offering to third parties**: Does the host repository deploy the SSPL component such that third parties (customers, partners, end users) can use the component's functionality? "Third parties" excludes employees of the operator and contractors working on the operator's behalf. Report yes / no / uncertain with evidence.
> 2. **Functionality offered**: What functionality of the SSPL component is exposed? Inspect API endpoints, exposed ports, application logic. Internal use of the component for the operator's own data processing, where the third-party-facing service does not surface the component's functionality, may not trigger §13. Direct exposure (e.g., offering a managed Redis API) does trigger §13. Report functionality details with evidence.
> 3. **Service Source Code scope**: If §13 triggers, identify which surrounding components fall within the Service Source Code definition (management, UI, APIs, automation, monitoring, backup, storage, hosting). This is the scope of source-disclosure obligation if compliance is the chosen path. Report the list with evidence.
>
> Output a JSON object exactly matching this schema:
>
> ```json
> {
>   "service_to_third_parties": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "functionality_exposed": {"answer": "...", "evidence": "..."},
>   "service_source_code_scope": ["..."],
>   "section_13_triggers": true|false,
>   "confidence": "high|medium|low",
>   "recommended_action": "...",
>   "human_review_required": true|false
> }
> ```
>
> SSPL §13 is broader and harder to comply with than AGPL §13. Where AGPL compliance generally requires only releasing the modified component's source, SSPL compliance can require releasing substantial proprietary infrastructure code. The recommended action in nearly all SaaS contexts is to remove the SSPL component or migrate to a permissively-licensed fork (Valkey for Redis, OpenSearch for Elasticsearch).

## Prompt template: BSL 1.1 competitive-offering evaluation

**When to invoke**: scanner has identified an HashiCorp BSL 1.1 component (Terraform > 1.5.5, Vault, Consul, Boundary, Waypoint, Nomad post-license-change) in the dependency tree.

**Inputs to provide**:
* Dependency tree path.
* The repository's `README.md`, `architecture.md`, product description / pitch deck if available.
* HashiCorp's current commercial-product list (provided as a static input, refreshed periodically).
* The BSL 1.1 license text.

**Prompt**:

> You are evaluating whether the host repository constitutes a "Competitive Offering" under HashiCorp's BSL 1.1 license, which would prohibit use of the BSL-licensed component in the host's commercial offering.
>
> BSL 1.1 defines a Competitive Offering as a product or service that is sold to third parties and:
> 1. Provides similar functionality to HashiCorp's commercial offerings, **or**
> 2. Embeds the BSL-licensed work such that the offering requires the BSL-licensed work to operate.
>
> Evaluate four factual questions, in order:
>
> 1. **Sold to third parties**: Is the host repository's product or service sold to third parties? Internal tools used only within the operating organization are not Competitive Offerings. Report yes / no / uncertain with evidence.
> 2. **Functional overlap with HashiCorp commercial offerings**: List HashiCorp's current commercial products (Terraform Cloud, HCP Vault, HCP Consul, etc., as supplied in the prompt input). Compare the host repository's functionality against each. Identify any meaningful overlap. Report findings with evidence.
> 3. **Embedded vs internal use**: Does the host repository embed the BSL-licensed component such that the host's offering requires the component to operate? "Embedded" means the host's customers receive or interact with the BSL component as part of the offering. "Internal use" means the host operator uses the BSL component to build or operate the offering, but customers do not interact with it. Report with evidence.
> 4. **Migration to fork available**: Is there a viable permissively-licensed fork (OpenTofu for Terraform, OpenBao for Vault) that the host could migrate to? Report with evidence.
>
> Output a JSON object exactly matching this schema:
>
> ```json
> {
>   "sold_to_third_parties": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "functional_overlap": [{"hashicorp_product": "...", "overlap_description": "...", "evidence": "..."}],
>   "embedded_use": {"answer": "yes|no|uncertain", "evidence": "..."},
>   "fork_available": {"answer": "...", "evidence": "..."},
>   "is_competitive_offering": true|false,
>   "confidence": "high|medium|low",
>   "recommended_action": "...",
>   "human_review_required": true|false
> }
> ```
>
> Competitive Offering is a contested term; HashiCorp's enforcement posture is evolving. When the determination is non-obvious, set `human_review_required` to `true` and surface for legal review. Migration to a fork is the safest resolution for any host that is or might become a Competitive Offering.

## Prompt template: dual-license selection

**When to invoke**: scanner finds a dependency declared under an `OR` SPDX expression (e.g., `MIT OR Apache-2.0`, `MPL-2.0 OR Apache-2.0`, `GPL-2.0-or-later WITH Classpath-exception-2.0 OR EPL-2.0`), and `.ort.yml` does not yet contain a `license_choices` entry for it.

**Inputs to provide**:
* The dependency identifier and version.
* The full SPDX expression.
* The host repository's outbound license declaration.
* The host repository's distribution model (proprietary SaaS, distributed binary, source-available, etc.).

**Prompt**:

> You are selecting the optimal license choice for a dual-licensed (or multi-licensed) dependency that the host repository consumes. The chosen license becomes the license under which the host repository is using the dependency.
>
> Evaluate the following:
>
> 1. **Outbound compatibility**: For each license option in the SPDX expression, evaluate whether it is compatible with the host repository's outbound license. Use the OSADL FOSS License Compatibility Matrix logic and FSF compatibility rules.
> 2. **Distribution-model fit**: For each compatible option, evaluate whether the license terms are appropriate for the host's distribution model. SaaS hosts should prefer options that do not have network-use triggers (avoid AGPL where it is one of the choices). Distributed-binary hosts should prefer options that minimize attribution and source-disclosure burden.
> 3. **Recommendation**: Select the single best license. Provide reasoning.
>
> Output:
>
> ```json
> {
>   "compatibility_evaluation": [
>     {"license": "...", "compatible_with_outbound": true|false, "reason": "..."}
>   ],
>   "distribution_fit_evaluation": [
>     {"license": "...", "fit_score": "high|medium|low", "reason": "..."}
>   ],
>   "selected_license": "...",
>   "reasoning": "...",
>   "confidence": "high|medium|low"
> }
> ```
>
> Once selected, the choice should be persisted in `.ort.yml` under `license_choices`, removing the need for re-evaluation on subsequent scans.

## Audit-trail schema

Every agentic invocation persists an audit-trail entry. Recommended schema:

```json
{
  "decision_id": "uuid",
  "timestamp": "ISO 8601",
  "commit_sha": "...",
  "trigger": "scanner-finding-id or manual",
  "prompt_template": "agpl-section-13 | sspl-section-13 | bsl-competitive-offering | dual-license",
  "input_file_hashes": {"path": "sha256", "...": "..."},
  "scanner_finding": { /* the deterministic finding that triggered the agent */ },
  "model_identifier": "claude-X.Y-YYYYMMDD",
  "prompt": "the full prompt sent to the model",
  "response": { /* the structured JSON response */ },
  "human_review": {
    "required": true|false,
    "reviewer": "...",
    "decision": "...",
    "decision_timestamp": "ISO 8601"
  }
}
```

The audit trail must be append-only and content-addressed (commit SHA + prompt-template hash + input-file-hash composite key). Replay against the same inputs produces a new entry, not a mutation of the old one. This preserves the historical record even if the model or prompt template is updated.

## When agentic review is overkill

Not every license finding deserves an agentic pass. Skip the agent when:

* The scanner finding is unambiguous (e.g., GPLv3 dependency in a clearly-internal CLI tool, AGPL dependency that has been allowlisted with documented exception).
* The repository has a standing `license_choices` curation covering the case.
* The deterministic policy in `rules.kts` produces a definitive verdict.

Reserve the agent for cases where the legal trigger genuinely depends on facts about the host application that the scanner cannot read. Overuse of the agent introduces latency, cost, and audit-log noise without compliance gain.
