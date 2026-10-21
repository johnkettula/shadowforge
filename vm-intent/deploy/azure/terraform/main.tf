# vm-intent sandbox on one Azure Linux VM:
# resource group, network locked to your IP, Ubuntu 24.04 VM, Premium SSD for data,
# and cloud-init that installs Docker and starts deploy/docker-compose.yml.

locals {
  # *_v6 sizes only have NVMe disk controllers.
  nvme      = can(regex("_v6$", var.vm_size))
  web_ports = ["8088", "8080", "8443", "8233"] # web app, API (HTTP; HTTPS with client certificates), Temporal UI
}

resource "azurerm_resource_group" "rg" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = var.tags
}

# ------------------------------------------------------------------ network

resource "azurerm_virtual_network" "vnet" {
  name                = "${var.name}-vnet"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = ["10.40.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "vm" {
  name                 = "vm"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.40.1.0/24"]
}

resource "azurerm_network_security_group" "nsg" {
  name                = "${var.name}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

  security_rule {
    name                       = "ssh-from-allowed"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.allowed_cidrs
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "web-from-allowed"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = local.web_ports
    source_address_prefixes    = var.allowed_cidrs
    destination_address_prefix = "*"
  }
  # Everything else inbound is denied by Azure's default rules. Temporal's port 7233 is not exposed.
}

resource "azurerm_subnet_network_security_group_association" "vm" {
  subnet_id                 = azurerm_subnet.vm.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

resource "azurerm_public_ip" "pip" {
  name                = "${var.name}-pip"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_network_interface" "nic" {
  name                = "${var.name}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.vm.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.pip.id
  }
}

# ------------------------------------------------------------------ VM

resource "azurerm_linux_virtual_machine" "vm" {
  name                            = "${var.name}-vm"
  location                        = azurerm_resource_group.rg.location
  resource_group_name             = azurerm_resource_group.rg.name
  size                            = var.vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.nic.id]
  disk_controller_type            = local.nvme ? "NVMe" : "SCSI"
  tags                            = var.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    name                 = "${var.name}-osdisk"
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 64
  }

  # Ubuntu 24.04 LTS, Gen2 (needed for v6 sizes and NVMe).
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # cloud-init: Docker, data disk, clone, generate passwords on the VM, docker compose up.
  # Passwords are made on the VM itself, so they never appear in Terraform state.
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username    = var.admin_username
    repo_url          = var.repo_url
    repo_subdir       = var.repo_subdir
    workers           = var.workers
    data_disk_size_gb = var.data_disk_size_gb
  }))

  boot_diagnostics {} # managed storage: see boot logs in the portal
}

resource "azurerm_managed_disk" "data" {
  name                 = "${var.name}-data"
  location             = azurerm_resource_group.rg.location
  resource_group_name  = azurerm_resource_group.rg.name
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  tags                 = var.tags
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.vm.id
  lun                = 0
  caching            = "None" # database writes: no host cache
}

# Stops the VM every evening so an idle sandbox costs little. Start it again in the portal
# or with: az vm start -g <rg> -n <vm>
resource "azurerm_dev_test_global_vm_shutdown_schedule" "nightly" {
  count                 = var.auto_shutdown_time == null ? 0 : 1
  virtual_machine_id    = azurerm_linux_virtual_machine.vm.id
  location              = azurerm_resource_group.rg.location
  enabled               = true
  daily_recurrence_time = var.auto_shutdown_time
  timezone              = var.auto_shutdown_timezone
  tags                  = var.tags

  notification_settings {
    enabled = false
  }
}
