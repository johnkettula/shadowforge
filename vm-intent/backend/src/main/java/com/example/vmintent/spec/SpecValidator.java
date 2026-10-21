package com.example.vmintent.spec;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Policy checks that run after the AI and before anything is built. */
public final class SpecValidator {

    public static final Set<String> PROVIDERS = Set.of("vsphere", "aws", "azure", "gcp");
    public static final Set<String> CLOUD_REGIONS = Set.of("us-east", "us-west", "us-central", "eu-west");
    public static final Set<String> DATACENTERS = Set.of("dc1", "dc2");
    public static final Set<String> OS = Set.of("ubuntu", "rhel", "windows", "debian", "rocky");

    private SpecValidator() {}

    public static List<String> problems(VmSpec s) {
        List<String> p = new ArrayList<>();
        if (!PROVIDERS.contains(s.provider())) p.add("Unknown platform '" + s.provider() + "'.");
        if ("vsphere".equals(s.provider()) && !DATACENTERS.contains(s.region()))
            p.add("vSphere VMs must go in a datacenter (dc1 or dc2), not '" + s.region() + "'.");
        if (!"vsphere".equals(s.provider()) && !CLOUD_REGIONS.contains(s.region()))
            p.add("Region '" + s.region() + "' isn't available in " + s.provider() + ".");
        if (s.vcpu() < 1 || s.vcpu() > 64) p.add("vCPU must be between 1 and 64 (got " + s.vcpu() + ").");
        if (s.memoryGiB() < 1 || s.memoryGiB() > 512) p.add("Memory must be 1-512 GiB (got " + s.memoryGiB() + ").");
        if (s.diskGiB() < 10 || s.diskGiB() > 4096) p.add("Disk must be 10-4096 GiB (got " + s.diskGiB() + ").");
        if (!OS.contains(s.os())) p.add("Operating system '" + s.os() + "' isn't on the approved list.");
        if ("windows".equals(s.os()) && s.diskGiB() < 64) p.add("Windows needs at least a 64 GiB disk.");
        if (s.ttlDays() < 0 || s.ttlDays() > 365) p.add("Lifetime must be 0-365 days.");
        return p;
    }
}
