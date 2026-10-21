# vm-intent sandbox on Azure (Terraform)

One `terraform apply` creates a Linux VM that runs the whole scaled stack from
`deploy/docker-compose.yml`: Postgres, a Postgres-backed Temporal server, the Temporal UI, the API,
3 workers and the web app.

## What it creates

| Resource | Details |
|---|---|
| Resource group | `vmintent-rg` |
| Network | VNet 10.40.0.0/16, one subnet, NSG allowing only `allowed_cidrs` to reach ports 22, 8088, 8080 and 8233 |
| Public IP | Static, Standard SKU |
| VM | `Standard_D8s_v6` (8 vCPU, 32 GiB), Ubuntu 24.04 LTS Gen2, SSH key only, 64 GiB OS disk |
| Data disk | 128 GiB Premium SSD, mounted at `/var/lib/docker` (all container data) |
| Auto-shutdown | Every day at 19:00 Eastern (change or turn off with `auto_shutdown_time`) |

On first boot, cloud-init:
1. installs Docker;
2. formats and mounts the data disk;
3. clones this repository;
4. generates the database passwords on the VM, so they never appear in Terraform state;
5. runs `docker compose up -d --build`.

## Cost

`Standard_D8s_v6` in East US is about $0.40/hour on demand (about $294/month if left on all the
time, about $183/month with a 1-year reservation). The disks and public IP add a little. With the
nightly shutdown, you pay compute only for the hours it runs. Check the Azure pricing calculator for
your region.

## Use it

You need the Azure CLI and Terraform 1.6+.

```
az login
cd deploy/azure/terraform
cp terraform.tfvars.example terraform.tfvars    # set ssh_public_key and allowed_cidrs
terraform init
terraform apply
```

First boot takes about 10 minutes, mostly the Docker images and the Maven build. To watch it, run
the `setup_log` command that `terraform apply` prints. Then:

```
terraform output web_app        # http://<ip>:8088
ssh azureuser@<ip>
cd /opt/vm-intent-src/vm-intent
node loadtest/run-loadtest.mjs --count 2000 --fail 20
```

More workers: `cd /opt/vm-intent-src/vm-intent/deploy && docker compose up -d --scale worker=6`.

Remove everything: `terraform destroy`.

## If the repository is private

The clone will fail, and the log says so. Copy the code over, then re-run the setup:

```
scp -r vm-intent azureuser@<ip>:/tmp/
ssh azureuser@<ip> 'sudo mkdir -p /opt/vm-intent-src && sudo mv /tmp/vm-intent /opt/vm-intent-src/ && sudo /usr/local/bin/vm-intent-setup.sh'
```

## Notes

- **Provider version:** pinned to `azurerm` 4.x, which this template was written against. 5.x is
  out; test before switching.
- **v6 sizes use NVMe disks.** The template sets `disk_controller_type = "NVMe"` for any `*_v6`
  size, and finds the data disk by its size rather than its device name.
- **Security:** never put `0.0.0.0/0` in `allowed_cidrs`; the template refuses it. For anything
  beyond a sandbox, drop the public IP and use Azure Bastion or a VPN, and put Entra ID sign-in in
  front of the web app and API.
- **Quotas:** a new subscription may need a vCPU quota increase for the DSv6 family (8 vCPU for
  this VM).
