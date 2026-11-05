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
- **Calls:** `put`, `get` and `delete` of an ARM path, always with `?api-version=` (Microsoft.Compute
  2024-07-01, Microsoft.Network 2024-05-01, or one the caller gives).
- **Long-running operations:** a PUT or DELETE answered with `Azure-AsyncOperation` (or 202 with `Location`)
  is polled, as often as `Retry-After` asks, until it ends; `put` then returns the resource. Only addresses
  under `management-url` are polled, so the token goes nowhere else.

| Answer | Retried by the client | Then fails as | Temporal retries it |
|---|---|---|---|
| 429, 502, 503, 504, no answer | 4 tries, backoff 2 s doubling or `Retry-After` (max 60 s) | `CloudBusy` | yes |
| other 5xx | the same | `CloudError` | yes |
| 401, 403, any sign-in refusal | no | `CloudAuth` | no |
| 404 | no | `NotFound` | no |
| other 4xx | no | `InvalidSpec` | no |
| operation `Failed` / `Canceled` | no | `CloudError`, with ARM's message | no |
| operation still running after 30 minutes | no | `CloudBusy` | yes |

## Tests

`ArmClientTest` runs the client against `MockArm`, a stateful stand-in for sign-in and ARM on 127.0.0.1
(see its comments). No test calls real Azure.
