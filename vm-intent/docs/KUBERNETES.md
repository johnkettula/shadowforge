# Running on Kubernetes

Last updated 2026-11-11.

All of vm-intent's workers run on Kubernetes. The manifests are in `deploy/kubernetes`, as
kustomize bases and overlays:

```
deploy/kubernetes/
  base/                    the API, the web app, two kinds of worker, volumes, autoscaling
  overlays/dev/            one pod of each, sign-in off, a throwaway database password
  overlays/prod/           three API pods, Entra ID sign-in, OPA, an Ingress with TLS
```

```
kubectl create namespace vm-intent-dev
kubectl apply -k deploy/kubernetes/overlays/dev
```

Temporal and Postgres aren't in these manifests. Use Temporal's Helm chart (or Temporal Cloud) and a
managed Postgres, and set `TEMPORAL_ADDRESS` and `VMINTENT_DB_URL` in the overlay. Both overlays
build with `kustomize build` and pass `kubernetes-validate --strict` for Kubernetes 1.30.

Both overlays also send clouds over the [one-way link to domain 3](ONE-WAY-LINK.md):

| Overlay | Settings | What it means |
|---|---|---|
| dev | `VMINTENT_LINK_PROVIDERS=gcp`, `VMINTENT_LINK_SIMULATE=true` | Google Cloud goes over the link, to a simulated domain 3 (vm-intent answers the orders itself); the other clouds are called directly |
| prod | `VMINTENT_LINK_PROVIDERS=*` | every cloud goes over the link, so the nightly inventory check skips every cloud |

Change `VMINTENT_LINK_PROVIDERS` in the overlay to call a cloud directly.

## The pods

| Deployment | Profile | Task queues | Scales |
|---|---|---|---|
| `vm-intent-api` | `api` | none (it starts workflows, runs none) | replicas |
| `vm-intent-worker-workflows` | `worker` | `intent-q`: every workflow, and their database and file activities | HPA, 2-10 (prod 2-20, dev 1-3) |
| `vm-intent-worker-clouds` | `worker` | every cloud's `-q` and `-read-q` | HPA, 2-8 (dev 1-3) |
| `vm-intent-web` | | nginx with the web app; forwards `/api` to the API | replicas |

The HPAs add pods at 70% CPU (`base/autoscaling.yaml`). The dev overlay sets both to 1-3 pods.

`VMINTENT_WORKER_QUEUES` decides which task queues a pod works on (empty = all). To scale one cloud
on its own, copy `worker-clouds.yaml` as `worker-aws.yaml` with `VMINTENT_WORKER_QUEUES=aws-q,aws-read-q`
and take those queues out of the clouds deployment. The per-cloud rate limits still hold across all
pods, because Temporal enforces them on the server.

Adding a worker pod needs nothing else: work is shared through the task queues. When a pod is
removed (scale-down, rollout, node drain), it stops taking work and lets its running tasks finish
(`terminationGracePeriodSeconds`: 60 for worker pods, 30 for the API pod, which runs no tasks);
anything unfinished is retried by another pod. Pod disruption budgets let drains take one pod at a
time.

## Health checks

Worker pods have no web server, so every pod (API included) answers on port 8081
(`VMINTENT_HEALTH_PORT`):

| | |
|---|---|
| `/healthz/live` | 200 while the process runs (liveness and startup probes) |
| `/healthz/ready` | 200 when the workers are running and Temporal and Postgres answer (readiness probe) |

## Volumes

| Claim | Mounted at | Holds |
|---|---|---|
| `vm-intent-shared` (ReadWriteMany) | `/data` | the file store, the simulated VMs' disks, the one-way link's outbox and inbox |
| `vm-intent-archive` (ReadWriteMany) | `/archive` | the write-once archive of workflow histories, kept 1-5 years |

Every worker must see the same folders, so both need a ReadWriteMany storage class (NFS, Azure
Files, EFS, CephFS). The prod overlay puts the archive on `rwx-retain`, a class whose reclaim policy
is Retain, so deleting the claim doesn't delete the audit data. Change the name to yours.

## Security

- Pods run as user 10001, with a read-only root filesystem, no capabilities and the default seccomp
  profile; `/tmp` is an emptyDir.
- No Kubernetes API token is mounted (`automountServiceAccountToken: false`).
- The database password comes from the `vm-intent-secrets` Secret. In prod it's made from
  `overlays/prod/secrets.env`, which Git ignores (copy `secrets.env.example`).

## Images

The same backend image runs as the API or as a worker (`backend/Dockerfile`); the web app has its own
(`frontend/Dockerfile`). Set the registry and tags in the overlay's `images:`.
