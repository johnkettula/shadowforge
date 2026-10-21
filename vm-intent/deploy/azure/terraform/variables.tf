variable "subscription_id" {
  description = "Azure subscription ID. Null = use ARM_SUBSCRIPTION_ID or the Azure CLI's current subscription."
  type        = string
  default     = null
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "vmintent"
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus"
}

variable "vm_size" {
  description = "VM size. D8s_v6 = 8 vCPU / 32 GiB. *_v6 sizes use NVMe disks; the template handles that."
  type        = string
  default     = "Standard_D8s_v6"
}

variable "data_disk_size_gb" {
  description = "Premium SSD for Docker data (Postgres, Temporal, images)."
  type        = number
  default     = 128
}

variable "admin_username" {
  description = "Linux admin user."
  type        = string
  default     = "azureuser"
}

variable "ssh_public_key" {
  description = "Your SSH public key, e.g. the contents of ~/.ssh/id_ed25519.pub. Password login is disabled."
  type        = string
}

variable "allowed_cidrs" {
  description = "Who may reach SSH and the web ports, e.g. [\"203.0.113.7/32\"] for your own IP. Never 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && !contains(var.allowed_cidrs, "0.0.0.0/0")
    error_message = "List at least one CIDR, and don't open the VM to the whole internet (0.0.0.0/0)."
  }
}

variable "repo_url" {
  description = "Git repository to clone. For a private repo, leave the default and copy the code over yourself (see README)."
  type        = string
  default     = "https://github.com/johnkettula/shadowforge.git"
}

variable "repo_subdir" {
  description = "Folder inside the repository that holds the project."
  type        = string
  default     = "vm-intent"
}

variable "workers" {
  description = "How many worker containers to start."
  type        = number
  default     = 3
}

variable "auto_shutdown_time" {
  description = "Daily shutdown time (24-hour HHMM) so an idle sandbox doesn't run all night. Null = never."
  type        = string
  default     = "1900"
}

variable "auto_shutdown_timezone" {
  description = "Windows time zone name for the shutdown schedule."
  type        = string
  default     = "Eastern Standard Time"
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default = {
    project = "vm-intent"
    env     = "sandbox"
  }
}
