package com.example.vmintent.spec;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * The Canonical VM Spec: one provider-neutral description of a VM.
 *
 * Every input (plain English, Slack, the legacy JSON API) is turned into
 * this record before anything is provisioned. Values are always abstract
 * ("us-east", "ssd", "ubuntu"), never provider names like "t3.xlarge" —
 * the provider adapters translate those.
 */
@Schema(description = "The canonical, cloud-neutral VM spec. Its SHA-256 (specHash) is the VM's identity.")
public record VmSpec(
        @Schema(description = "VM name. Generated from the hash if left empty.", example = "app-db-01")
        String name,
        @Schema(allowableValues = {"vsphere", "aws", "azure", "gcp"}, example = "aws")
        String provider,
        @Schema(description = "Cloud regions: us-east, us-west, us-central, eu-west. vSphere datacenters: dc1, dc2.",
                allowableValues = {"us-east", "us-west", "us-central", "eu-west", "dc1", "dc2"}, example = "us-east")
        String region,
        @Schema(minimum = "1", maximum = "64", example = "4")
        int vcpu,
        @Schema(minimum = "1", maximum = "512", example = "16")
        int memoryGiB,
        @Schema(allowableValues = {"ubuntu", "rhel", "windows", "debian", "rocky"}, example = "ubuntu")
        String os,
        @Schema(example = "24.04")
        String osVersion,
        @Schema(description = "Windows needs at least 64.", minimum = "10", maximum = "4096", example = "100")
        int diskGiB,
        @Schema(allowableValues = {"ssd", "standard"}, example = "ssd")
        String diskTier,
        @Schema(allowableValues = {"dev", "test", "staging", "prod"}, example = "dev")
        String env,
        @Schema(description = "Lifetime in days; 0 = never expires.", minimum = "0", maximum = "365", example = "14")
        int ttlDays,
        @Schema(example = "false")
        boolean publicIp
) {
    public VmSpec withName(String newName) {
        return new VmSpec(newName, provider, region, vcpu, memoryGiB, os, osVersion,
                diskGiB, diskTier, env, ttlDays, publicIp);
    }
}
