# Files for client-certificate sign-in

docker-compose mounts this folder into the API container at `/etc/vm-intent/pki` (read-only).
Put these files here (none of them are committed):

| File | What | Setting |
|---|---|---|
| `server.crt` | The API's TLS certificate, plus any intermediate CAs (PEM) | `VMINTENT_TLS_CERT` |
| `server.key` | Its private key (PEM, unencrypted; `chmod 600`) | `VMINTENT_TLS_KEY` |
| `ca-bundle.pem` | The CAs that issue client certificates (PEM, root and/or issuing CAs) | `VMINTENT_PKI_CA_FILE` |
| `pki-clients.yml` | The allowlist; start from `pki-clients.example.yml` | `VMINTENT_PKI_CLIENTS_FILE` |
| `crl.pem` | Optional: CRLs from the issuing CAs, refreshed regularly | `VMINTENT_PKI_CRL_FILE` |

Setup steps are in `docs/SECURITY.md`, under "Client certificates (PKI)".
