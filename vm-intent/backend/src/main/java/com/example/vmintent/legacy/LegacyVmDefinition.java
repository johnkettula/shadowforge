package com.example.vmintent.legacy;

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
public record LegacyVmDefinition(
        String name,
        String cloud,
        String location,
        Integer cpu,
        Integer ramGb,
        Image image,
        Disk disk,
        String environment,
        Integer ttlDays,
        Boolean publicIp
) {
    public record Image(String os, String version) {}

    public record Disk(Integer sizeGb, String type) {}
}
