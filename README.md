# shadowforge

## vm-intent

[`vm-intent/`](vm-intent/) — request a virtual machine in plain English. One canonical,
cloud-neutral spec comes out, and a Temporal workflow builds it on vSphere, AWS, Azure
or Google Cloud (simulated). React + TypeScript front end, Spring Boot 3 + Temporal back end,
embedded Postgres with an audit trail, and an MCP server for using it from Claude.

See [`vm-intent/README.md`](vm-intent/README.md) to install and run it.

## agent-pipeline

[`agent-pipeline/`](agent-pipeline/) — an autonomous pipeline, run as a Temporal workflow, that keeps
improving vm-intent: Claude agents choose a requirement, build it, write acceptance tests and review
it; the pipeline runs the build gates, deploys to staging, merges, deploys live, and reverts
automatically if live breaks. Guardrails, limits and setup are in
[`agent-pipeline/README.md`](agent-pipeline/README.md).
