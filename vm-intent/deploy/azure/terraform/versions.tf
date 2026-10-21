terraform {
  required_version = ">= 1.6"

  required_providers {
    # Pinned to the 4.x line, which this template was written against.
    # 5.x exists; test before moving to it.
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.20, < 5.0"
    }
  }
}

provider "azurerm" {
  features {}
  # Leave null to use the ARM_SUBSCRIPTION_ID environment variable or `az account set`.
  subscription_id = var.subscription_id
}
