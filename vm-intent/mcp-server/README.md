# vm-intent MCP server

Last updated 2026-11-09.

Lets Claude (or any MCP client) drive the vm-intent app running on this PC.

| Tool | What it does |
|---|---|
| `vm_interpret` | Preview how a request is understood: spec, hash, defaults. Builds nothing. |
| `vm_submit` | Start a request workflow; returns its question or the spec to confirm |
| `vm_answer` | Answer the workflow's clarifying question |
| `vm_confirm` | Confirm and build (only after the user says yes) |
| `vm_cancel` | Cancel a waiting request |
| `vm_status` | State, spec, VM details and optional workflow history |
| `vm_list` | The VM inventory (from Postgres) |
| `vm_audit` | Audit trail for a request or spec hash, or the latest events |
| `vm_list_test_sets` | The phrasing test files in `tests/` |
| `vm_run_tests` | Run a test set against the backend; pass / silent-wrong counts and failures |
| `vm_batch_submit` | Build many VMs from a list of plain-English requests (no per-VM confirm; get the user's yes first) |
| `vm_batch_status` | Live counts for a batch: in flight, running, failed, duplicates, p50/p95 build time |

## Setup

From the project folder, double-click `4-setup-mcp.cmd`. It runs `npm install` and `npm run build`
here, then adds this server to `%APPDATA%\Claude\claude_desktop_config.json` (backing the file up first).
Restart the Claude desktop app.

The app must be running for the tools to work: `1-start-temporal.cmd`, then `2-start-backend.cmd`.

Settings, set in the Claude config's `env` block:

- `VMINTENT_API_BASE`: backend address, default `http://localhost:8080`
- `VMINTENT_HOME`: project folder, default the folder above `mcp-server`
- `VMINTENT_API_TOKEN`: an Entra ID access token, for an API with sign-in on. It's sent as
  `Authorization: Bearer <token>` on every API call. Empty (the default) sends no token. See
  `docs/SECURITY.md`.

## GitLab

GitLab ships its own MCP server (generally available from GitLab 19.5) at
`https://<your-gitlab>/api/v4/mcp`. Put your GitLab address in `gitlab-host.txt` in the project
folder before running `4-setup-mcp.cmd`, and it's registered alongside this one. The first
connection opens a browser to approve access. A GitLab admin must allow MCP access.
