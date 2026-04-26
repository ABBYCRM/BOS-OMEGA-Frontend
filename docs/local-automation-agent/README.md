# Local Automation Agent — documentation index

This directory holds the program-level documentation for the BOS-OMEGA Local Automation Agent (LAA): the structured-task, signed-request, hash-chain-audited replacement for the prior PowerShell bridge.

The LAA program spans 10 project tasks across 7 workstreams. Six of those tasks are buildable in this Linux Replit container (#21, #22, #23, #24, #25, #32); four are deferred Windows-only deliverables (#26, #27, #28, #29) that require a real Windows build host.

## Documents in this directory

| File | Purpose | Audience |
|---|---|---|
| [MASTER_PLAN.md](./MASTER_PLAN.md) | Authoritative roadmap. Roadmap snapshot, dependency graph, 5-phase execution sequence, critical-path analysis, validation matrix (architectural decisions × BOS-POLICY-001..010 × BOS-ENT-001..006 × spec section 13 ship-gate × owning task), cancellation rebaseline for tasks #4 and #15, owner & update protocol. | Anyone planning, sequencing, reviewing, or auditing LAA work. |
| [enterprise-config.md](./enterprise-config.md) *(planned — owned by [task #32](../../.local/tasks/multi-user-enterprise-hooks.md))* | Schema for the JSON config the agent reads on start under admin deployment: `server_url`, `org_enrollment_secret`, `allowlist_overrides`, `blocklist_extensions`, `telemetry_endpoint`, `audit_export_endpoint`. Consumed by the deferred MSI ([#29](../../.local/tasks/laa-09-installer-deferred.md)) and tray ([#27](../../.local/tasks/laa-07-windows-tray-prompts-deferred.md)) tasks. | Operators deploying via Intune / GPO / RMM; engineers building the MSI. |

## Source-of-truth references (outside this directory)

- **Spec** (policy YAML/JSON, BOS-POLICY-* matrix, section 13 ship-gate, section 14 final-build rule): [`attached_assets/Pasted-text-TRI-STATE-GO-MODE-EXECUTION-ONLY-TARGET-BOS-OMEGA-_1777210493011.txt`](../../attached_assets/Pasted-text-TRI-STATE-GO-MODE-EXECUTION-ONLY-TARGET-BOS-OMEGA-_1777210493011.txt)
- **Architectural decisions of record** (7 decisions: installer, pairing/device trust, approval UX, audit immutability, Windows user model, update model, deployment model): [`attached_assets/Pasted-ARCHITECTURAL-DECISIONS-These-are-now-resolved-Proceed-_1777212351123.txt`](../../attached_assets/Pasted-ARCHITECTURAL-DECISIONS-These-are-now-resolved-Proceed-_1777212351123.txt)
- **Auto-install consent rules**: see the `attached_assets/Pasted-AUTO-INSTALL-CONSENT-DOC-*.txt` files in [`attached_assets/`](../../attached_assets/).
- **Per-task plans** (build-now): [#21](../../.local/tasks/laa-01-core-policy-engine.md) · [#22](../../.local/tasks/laa-02-api-signed-requests-audit.md) · [#23](../../.local/tasks/laa-03-pairing-approval-ui.md) · [#24](../../.local/tasks/laa-04-reference-agent-and-dev-console.md) · [#25](../../.local/tasks/laa-05-spec-tests-and-ship-gate.md) · [#32](../../.local/tasks/multi-user-enterprise-hooks.md)
- **Per-task plans** (deferred Windows): [#26](../../.local/tasks/laa-06-windows-runtime-deferred.md) · [#27](../../.local/tasks/laa-07-windows-tray-prompts-deferred.md) · [#28](../../.local/tasks/laa-08-uac-broker-deferred.md) · [#29](../../.local/tasks/laa-09-installer-deferred.md)

## How to read the master plan

If you are about to **start a new LAA project task**: read Sections A (roadmap) and B (dependency graph) to confirm your task's prerequisites are merged, then read the row for your task in Section E (validation matrix) to know which BOS-POLICY-* / BOS-ENT-* / ship-gate items you are accountable for.

If you are about to **cancel, add, or reshape a project task**: read Section G (owner & update protocol) first. Any roadmap change requires this document to be updated in the same merge as the task plan change.

If you are **reviewing a merge**: cross-check the changed plan files against Sections A and B, then verify Section E still binds every spec rule to a task. If a row goes orphaned, the merge is not ready.

If you are **debugging "why was the PowerShell bridge cancelled?"**: read Section F (cancellation rebaseline). Every concept from cancelled tasks #4 and #15 is mapped to its current owner or marked deliberately dropped with a reason.

## Build status legend

- **[BUILD-NOW]** — buildable in this Linux Replit container. Safe to assign to a task agent.
- **[BLOCKED-ENV]** — `IMPLEMENTATION_BLOCKED_BY_ENVIRONMENT`. Plan is committed to source so the contracts are frozen, but **do not** assign to a task agent in this project. Requires a Windows build host, Windows SDKs, an Authenticode publisher cert in an HSM, and a Windows test machine.
