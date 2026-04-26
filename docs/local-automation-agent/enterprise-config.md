# Local Automation Agent — Enterprise Config File

Audience: enterprise admins, MDM/GPO/RMM authors, and the maintainers of
the Windows MSI (Task #29) and tray (Task #27).

This document is the contract the deferred Windows tasks **must**
implement. The server-side schema and policy semantics that consume it
are already in place (see Task #32, Workstream 7).

---

## Where it lives

The agent reads its enterprise config from a single JSON file. The path
is **read-only input** — the agent never writes to it.

| Source | Default path |
| ------ | ------------ |
| MSI (silent install, admin deployment) | `%PROGRAMDATA%\BOS-Omega\agent.config.json` |
| MDM (Intune Win32 app) | `%PROGRAMDATA%\BOS-Omega\agent.config.json` (laid by the install script) |
| GPO (preferences > files) | Same path |
| RMM (Datto, NinjaOne, etc.) | Same path |

The path can be overridden at agent start with the env var
`BOS_AGENT_CONFIG_PATH=...`. If both the env var and the default are
present, the env var wins; this is the supported escape hatch for
enterprise pilots.

If the file is **missing**, the agent falls back to interactive
pair-code mode (Task #24). This is the intended behaviour for personal
installs.

If the file is **present but invalid**, the agent refuses to start and
writes the parse error to the Windows Event Log under
`Source = "BOS-Omega Agent"`. It does NOT silently fall back — a broken
config is a deploy bug, not a runtime degradation.

---

## File schema

```jsonc
{
  // Required. The bos-omega server URL the agent reports to.
  // Must be HTTPS in production. Ports allowed.
  "server_url": "https://bos.example.corp",

  // Required. Per-org enrollment secret minted by a super_admin in the
  // bos-omega Enterprise tab. The agent presents this on the
  // `/api/v1/devices/register?install_mode=ADMIN_DEPLOYMENT` call.
  // 32-512 chars. Treat it like a password — anyone with this secret
  // can register a device into the org.
  "org_enrollment_secret": "sk_org_abc123...redacted...",

  // Optional. Org-suggested defaults applied on first boot only.
  // The server-authoritative locks live in `bos_org_policy_overrides`
  // and override anything here.
  "allowlist_overrides": [
    "C:\\Program Files\\Acme\\runner.exe",
    "C:\\ProgramData\\BOS-Omega\\scripts\\*.ps1"
  ],

  // Optional. Extensions the agent will refuse to execute under any
  // policy. Always include the leading dot.
  "blocklist_extensions": [".vbs", ".bat"],

  // Optional. If set, the agent forwards execution telemetry here
  // (in addition to the server). Useful for SIEM integration.
  "telemetry_endpoint": "https://siem.example.corp/bos-omega",

  // Optional. If set, the agent posts a signed copy of every audit row
  // here on a 60s cadence. Used for compliance archival.
  "audit_export_endpoint": "https://archive.example.corp/bos-omega/audit",

  // Optional. The contract version the agent was compiled against.
  // The server uses this to refuse incompatible agents fast.
  "contract_version": "0.1.0"
}
```

The schema is validated at agent start by
`EnterpriseAgentConfigFileSchema` from
`@workspace/local-agent-contracts`. Schema-level changes require a
contract package version bump and an MSI re-cut.

---

## How the registration handshake works

1. Agent reads `agent.config.json`, validates it.
2. Agent generates a fresh device key pair (Task #21 / #26).
3. Agent calls `POST {server_url}/api/v1/devices/register?install_mode=ADMIN_DEPLOYMENT`
   with body:
   ```json
   {
     "org_enrollment_secret": "<from config file>",
     "device_pubkey": "<base64>",
     "display_name": "<computer name>",
     "hostname": "<DNS hostname>",
     "contract_version": "0.1.0"
   }
   ```
4. Server hashes the secret, looks it up against
   `bos_orgs.enrollment_secret_hash`, and on match writes a row into
   `bos_devices` with `org_id = <org>` and `install_mode = ADMIN_DEPLOYMENT`.
5. Agent stores the assigned `device_id` and proceeds to the normal
   task-evaluation loop.

After this, the device behaves identically to a personal-install device
on the wire — every request carries `org_id` and `windows_session`, and
the server enforces enterprise locks transparently.

---

## What the server enforces

| Enforcement | Where |
| ----------- | ----- |
| Cross-org approvals are rejected | `evaluateApproval` in `@workspace/local-agent-policy`. Reason `ENTERPRISE_ORG_MISMATCH`. |
| Org-locked policy fields can't be widened locally | `evaluatePolicyEdit` honors `bos_org_policy_overrides`. Reason `ENTERPRISE_POLICY_FIELD_LOCKED`. |
| Approvals are bound to one Windows SID | `evaluateExecutionGate`. Reason `SESSION_BINDING_MISMATCH`. |
| Admin-deployment devices can't downgrade to individual-consent | `evaluateInstallModeChange`. Reason `INSTALL_MODE_DOWNGRADE_DENIED`. |
| Audit chain is per-device, hash-chained | `bos_audit_log.row_hash` / `prev_row_hash` (Task #22). |

---

## Rotation

1. Super_admin rotates the enrollment secret in the Enterprise tab.
2. Server hashes and stores the new secret on `bos_orgs.enrollment_secret_hash`.
3. Old `agent.config.json` files keep working for **previously
   registered devices** — registration is one-shot, the secret is not
   re-checked on every request. New registrations require the new
   secret.
4. To force re-registration of a device, super_admin marks it
   `status = 'revoked'` in `bos_devices`. Next request from that
   device's key is rejected and the device must re-pair.

---

## Out of scope (lives in deferred Windows tasks)

- The MSI's `/quiet INSTALLDIR=...` admin-install variant — Task #29.
- The tray's "Enrollment status" pop-out — Task #27.
- The actual on-disk file deployment from Intune / GPO / RMM — operational,
  produced separately when a real Windows test environment exists.
