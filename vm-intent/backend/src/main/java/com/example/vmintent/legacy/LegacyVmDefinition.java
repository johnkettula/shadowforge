package com.example.vmintent.legacy;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * The OLD universal JSON format the existing API accepts.
 *
 * This shape is a placeholder — change these fields to match your real
 * legacy file, then adjust LegacySpecTranslator. Example:
 * {
 *   "name": "web-01", "cloud": "AWS", "location": "us-east-1",
 *   "cpu": 4, "ramGb": 16,
 *   "image": { "os": "Ubuntu", "version": "24.04" },
 *   "disk": { "sizeGb": 100, "type": "SSD" },
 *   "environment": "dev", "publicIp": false
 * }
 */
@Schema(description = "The legacy universal VM definition (v1). Provider-native names are accepted.")
public record LegacyVmDefinition(
        @Schema(example = "legacy-web-01") String name,
        @Schema(description = "AWS, Azure, GCP or vSphere.", example = "GCP") String cloud,
        @Schema(description = "Provider region name or datacenter.", example = "us-central1") String location,
        @Schema(example = "2") Integer cpu,
        @Schema(example = "8") Integer ramGb,
        Image image,
        Disk disk,
        @Schema(example = "test") String environment,
        @Schema(example = "14") Integer ttlDays,
        @Schema(example = "false") Boolean publicIp
) {
    public record Image(@Schema(example = "Debian") String os, @Schema(example = "12") String version) {}

    public record Disk(@Schema(example = "80") Integer sizeGb, @Schema(example = "SSD") String type) {}
}
