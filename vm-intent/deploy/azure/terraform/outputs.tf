output "public_ip" {
  value = azurerm_public_ip.pip.ip_address
}

output "ssh" {
  value = "ssh ${var.admin_username}@${azurerm_public_ip.pip.ip_address}"
}

output "web_app" {
  value = "http://${azurerm_public_ip.pip.ip_address}:8088"
}

output "api" {
  value = "http://${azurerm_public_ip.pip.ip_address}:8080"
}

output "temporal_ui" {
  value = "http://${azurerm_public_ip.pip.ip_address}:8233"
}

output "setup_log" {
  description = "Watch the first-boot setup (takes about 10 minutes: Docker images and the Maven build)."
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.pip.ip_address} sudo tail -f /var/log/vm-intent-setup.log"
}
