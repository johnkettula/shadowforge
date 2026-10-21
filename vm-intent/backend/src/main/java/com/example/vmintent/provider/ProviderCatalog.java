package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;

import java.util.Map;

/**
 * The mapping tables from abstract values to each provider's own names.
 * In a real system the platform team keeps this in a database or a YAML
 * file in Git; it's in code here to keep the starter project simple.
 */
public final class ProviderCatalog {

    private ProviderCatalog() {}

    private static final Map<String, Map<String, String>> REGIONS = Map.of(
            "aws", Map.of("us-east", "us-east-1", "us-west", "us-west-2", "us-central", "us-east-2", "eu-west", "eu-west-1"),
            "azure", Map.of("us-east", "eastus", "us-west", "westus2", "us-central", "centralus", "eu-west", "westeurope"),
            "gcp", Map.of("us-east", "us-east4", "us-west", "us-west1", "us-central", "us-central1", "eu-west", "europe-west1"),
            "vsphere", Map.of("dc1", "Datacenter-1 / Cluster-A", "dc2", "Datacenter-2 / Cluster-B"));

    /** Key = "vcpu/GiB". Anything not listed falls back to a custom size. */
    private static final Map<String, Map<String, String>> SIZES = Map.of(
            "aws", Map.of("1/2", "t3.small", "2/4", "t3.medium", "2/8", "m6i.large", "4/16", "m6i.xlarge",
                    "8/32", "m6i.2xlarge", "16/64", "m6i.4xlarge"),
            "azure", Map.of("1/2", "Standard_B1ms", "2/4", "Standard_B2s", "2/8", "Standard_D2s_v5",
                    "4/16", "Standard_D4s_v5", "8/32", "Standard_D8s_v5", "16/64", "Standard_D16s_v5"),
            "gcp", Map.of("1/2", "e2-small", "2/4", "e2-medium", "2/8", "e2-standard-2", "4/16", "e2-standard-4",
                    "8/32", "e2-standard-8", "16/64", "e2-standard-16"));

    public static ProviderPlan plan(VmSpec s) {
        String p = s.provider();
        String region = REGIONS.getOrDefault(p, Map.of()).getOrDefault(s.region(), s.region());
        String key = s.vcpu() + "/" + s.memoryGiB();
        String size = switch (p) {
            case "vsphere" -> s.vcpu() + " vCPU / " + s.memoryGiB() + " GiB (template clone)";
            case "gcp" -> SIZES.get(p).getOrDefault(key, "custom-" + s.vcpu() + "-" + (s.memoryGiB() * 1024));
            default -> SIZES.get(p).getOrDefault(key, "nearest size to " + key + " (catalog gap)");
        };
        String image = switch (p) {
            case "aws" -> "AMI lookup: " + s.os() + " " + s.osVersion();
            case "azure" -> "Marketplace image: " + s.os() + " " + s.osVersion();
            case "gcp" -> "Image family: " + s.os() + "-" + s.osVersion().replace(".", "");
            default -> "Template: tpl-" + s.os() + "-" + s.osVersion();
        };
        String summary = p + " " + region + ", " + size + ", " + image;
        return new ProviderPlan(region, size, image, summary);
    }
}
