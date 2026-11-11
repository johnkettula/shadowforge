# Real Azure

Azure requests are still simulated (VM IDs start with `az-vm-`). Part A1 adds `provider/azure`: the settings
(`AzureProperties`) and an Azure Resource Manager client (`ArmClient`); part A2a adds `AzureArmBackend`, which
builds VMs with it but is not connected yet.

## Settings

`vmintent.azure` in `application.yml`. The IDs and secret come only from `VMINTENT_AZURE_TENANT_ID`,
`..._CLIENT_ID` (the service principal), `..._CLIENT_SECRET` and `..._SUBSCRIPTION_ID`; never write them in a
file. VMs go in `resource-group` and `location` (`..._RESOURCE_GROUP`, `..._LOCATION`). `login-url` and
`management-url` default to `https://login.microsoftonline.com` and `https://management.azure.com`. Azure is
configured only when tenant, client ID, secret, subscription and resource group are all set. Neither the
secret nor the access token is ever logged or shown by `toString()`.

## How ArmClient talks to Azure

- **Sign-in:** `POST {login-url}/{tenant}/oauth2/v2.0/token` with `grant_type=client_credentials`, the client
  ID and secret, and `scope=https://management.azure.com/.default`. The token goes with every ARM call as
  `Authorization: Bearer ...` and is reused until less than 5 minutes of it are left; then a new one is
  fetched before the next call.
- **Calls:** every ARM path is sent with `?api-version=` (Microsoft.Compute 2024-07-01, Microsoft.Network
  2024-05-01, or one the caller gives).

## Two ways to use it

**Blocking: `put` and `delete`, for tools and tests, not for activities.** A PUT or DELETE answered with
`Azure-AsyncOperation` (or 202 with `Location`) is polled, as often as `Retry-After` asks, for up to 30 minutes
until it ends; `put` then returns the resource. Failed or Canceled is thrown as a non-retryable `CloudError`.
Only addresses under `management-url` are polled, so the token goes nowhere else. One `put` can take minutes,
far past an activity's timeout.

**Non-blocking: `begin`, `operation` and `get`, for activities.** `CloudOps` gives provider change calls a
30 s StartToClose and read calls 15 s, and Temporal does the retries, so each of these calls is short:

- `begin("PUT" | "DELETE", path, body)` sends the request once and returns without polling: ARM's status, the
  resource as ARM returned it, and the operation URL (`Azure-AsyncOperation`, or `Location` on a 202; null when
  the answer named none, e.g. a 204 for something already gone).
- `operation(url)` reads that operation once and returns `InProgress`, `Succeeded`, `Failed` or `Canceled`, with
  ARM's error code and message when it failed. Failed and Canceled are returned, not thrown. A URL that does not
  start with `management-url` is refused with a non-retryable `CloudError` before anything is sent.
- `get(path)` reads a resource.

Each of these calls has a **budget of 10 s, sign-in included** (`Tuning.CALL_BUDGET`), which fits the 15 s read
timeout: at most 4 attempts, each request at most 5 s (`Tuning.REQUEST_TIMEOUT`, and never more than
`timeout-seconds` or what is left of the budget), backoff 2 s doubling or `Retry-After`. A new attempt starts
only if it gets at least 1 s. When a wait (backoff or `Retry-After`) would take the call past its budget, the
client does not sleep: it throws a retryable `CloudBusy` at once, with Temporal's next retry delay set to that
wait (at most 60 s), so Temporal does the waiting.

The pattern for Azure part A2: each activity call moves one step and returns. The first call `begin`s the PUT
and returns the operation URL; the next activity calls `operation(url)` and, while it is `InProgress`, throws a
retryable `CloudBusy` ("not ready yet") so Temporal calls it again after its backoff; `Succeeded` moves on;
`Failed` or `Canceled` becomes a non-retryable failure with ARM's message.

| Answer | Retried by the client | Then fails as | Temporal retries it |
|---|---|---|---|
| 429, 502, 503, 504, no answer | 4 tries, backoff 2 s doubling or `Retry-After` (max 60 s) | `CloudBusy` | yes |
| other 5xx | the same | `CloudError` | yes |
| a wait (`Retry-After` or backoff) longer than what is left of the budget (`begin`, `operation`, `get`) | no, no wait | `CloudBusy`, next retry delay = that wait | yes |
| no time left in the budget for another request | no | `CloudBusy` | yes |
| 409 Conflict | no | `CloudBusy` | yes |
| 401, 403, any sign-in refusal | no | `CloudAuth` | no |
| 404 | no | `NotFound` | no |
| other 4xx | no | `InvalidSpec` | no |
| operation `Failed` / `Canceled` (`put` / `delete`) | no | `CloudError`, with ARM's message | no |
| operation `Failed` / `Canceled` (`operation`) | no | returned, with ARM's code and message | - |
| operation still running after 30 minutes (`put` / `delete`) | no | `CloudBusy` | yes |

## AzureArmBackend (part A2a)

`AzureArmBackend` builds, reads and removes one Linux VM with ARM, following the pattern above. It is **not
used by `AzureProvider` yet**: Azure requests stay simulated. Part A2b connects it behind `vmintent.azure.route`.

- **VM ID:** `arm:<resource-group>:<vm-name>`, e.g. `arm:rg-vmintent:app-db-01` (never `az-vm-`, the
  simulator's prefix). `owns(vmId)` is true for IDs starting with `arm:`.
- **Resources**, all in `resource-group` and `location`: the public IP `<name>-pip` (Standard, static), the NIC
  `<name>-nic` on `subnet-id` with that public IP, and the VM `<name>` (OS disk removed with it).
- **Tags** on all three: `vm-intent=managed` and `vm-intent-key=<idempotency key>`. A resource without
  `vm-intent=managed` is never changed or removed. An existing VM with the requested name is adopted only when
  its recorded vm-intent key (`vm-intent-key`) has the same spec hash as the new build key (a retry, or a new run
  of the same VM); otherwise it is refused with non-retryable `InvalidSpec` ("was built by vm-intent for another
  request; choose another name") and nothing is sent. A `vm-intent=managed` VM with no `vm-intent-key` tag (built
  before keys were read back) is still adopted.
- **Settings** (`AzureVmProperties`, next to `AzureProperties`): `subnet-id` (`VMINTENT_AZURE_SUBNET_ID`, the full
  ARM ID of an existing subnet), `admin-username` (`VMINTENT_AZURE_ADMIN_USERNAME`, default `azureuser`) and
  `admin-ssh-public-key` (`VMINTENT_AZURE_ADMIN_SSH_PUBLIC_KEY`). VMs get SSH key sign-in only, no password.
- **Images** (by `os-version`, then `os-major`): `ubuntu-24.04` Canonical/ubuntu-24_04-lts/server,
  `ubuntu-22.04` Canonical/0001-com-ubuntu-server-jammy/22_04-lts-gen2, `debian-12` Debian/debian-12/12-gen2,
  `rhel-9` RedHat/RHEL/9-lvm-gen2. Others, Windows included (it needs a password), are refused. `plan` gives the
  size and region from `ProviderCatalog` and this image.

Each call reads what ARM has, moves at most one step with `begin` and returns or throws; it keeps no state.

| Call | Step | When not ready / refused |
|---|---|---|
| `createVm` | checks the settings | non-retryable `NotSetUp` naming what is missing; nothing is sent |
| | checks the spec: an image for the OS, a region that maps to `location`, a catalog size | non-retryable `InvalidSpec`, before any PUT |
| | a VM of that name exists: tagged, with the same spec hash in `vm-intent-key` (or no key), returns its ID (no PUT); untagged, or built for another spec | non-retryable `InvalidSpec`, nothing sent |
| | public IP: PUT if missing; wait for `Succeeded` | retryable `CloudBusy` (`CloudError` if `Failed`) |
| | NIC: the same | the same |
| | VM: PUT, then return its ID at once | - |
| `describeVm` | reads only: `PENDING` until the VM is `Succeeded`, then `RUNNING` with the public IP's address; `FAILED` with ARM's message | missing or untagged VM: non-retryable `VmNotFound` |
| `deleteVm` | VM, then NIC, then public IP: DELETE what still exists; returns once all three are gone | retryable `CloudBusy` while a delete runs; untagged: non-retryable `InvalidSpec`, no DELETE |

`CLOUD_RETRY` keeps retrying `CloudBusy` for up to 30 minutes, so Temporal does the waiting.

## Tests

`AzureArmBackendTest` calls the backend again after each `CloudBusy`, as Temporal would, against `MockArm`.
In `MockArm`, reading a resource while its operation runs counts as a poll of that operation.

`ArmClientTest` runs the client against `MockArm`, a stateful stand-in for sign-in and ARM on 127.0.0.1
(see its comments). No test calls real Azure. `MockArm.responseDelay` holds its answers to test the request
timeout, and the budget tests measure that a call ends in under 15 s.
