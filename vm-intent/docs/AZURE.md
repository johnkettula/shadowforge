# Real Azure

Azure requests are still simulated (VM IDs start with `az-vm-`). Part A1 adds `provider/azure`: the settings
(`AzureProperties`) and an Azure Resource Manager client (`ArmClient`); part A2 will build VMs with it.

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

## Tests

`ArmClientTest` runs the client against `MockArm`, a stateful stand-in for sign-in and ARM on 127.0.0.1
(see its comments). No test calls real Azure. `MockArm.responseDelay` holds its answers to test the request
timeout, and the budget tests measure that a call ends in under 15 s.
