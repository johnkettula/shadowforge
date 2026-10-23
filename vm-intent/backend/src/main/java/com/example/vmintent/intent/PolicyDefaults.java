package com.example.vmintent.intent;

import com.example.vmintent.spec.VmSpec;

import java.util.List;
import java.util.Map;

/**
 * Platform-team rules that fill in whatever the user didn't say. Living in
 * code (not in an AI prompt) is what guarantees two vague requests come out
 * with the same defaults.
 */
public final class PolicyDefaults {

    /** Size catalog: class -> {vCPU, GiB}. */
    public static final Map<String, int[]> SIZES = Map.of(
            "xsmall", new int[]{1, 2},
            "small", new int[]{2, 4},
            "medium", new int[]{4, 16},
            "large", new int[]{8, 32},
            "xlarge", new int[]{16, 64});

    private static final Map<String, String> OS_DEFAULT_VERSION = Map.of(
            "ubuntu", "24.04", "rhel", "9", "windows", "2022", "debian", "12", "rocky", "9");

    private static final Map<String, Integer> TTL_BY_ENV = Map.of(
            "dev", 30, "test", 14, "staging", 30, "prod", 0);

    /** Most VMs one request can ask for. More than that is a batch (POST /api/v2/batches). */
    public static final int MAX_COUNT = 20;

    private PolicyDefaults() {}

    /** Returns the question to ask if a required field is missing, otherwise null. */
    public static String missingQuestion(IntentDraft d) {
        if (d.provider == null) {
            return "Which platform should this run on: vSphere (on-prem), AWS, Azure or Google Cloud?";
        }
        if (d.count != null && d.count > MAX_COUNT) {
            return "One request can build up to " + MAX_COUNT + " VMs (for more, use a batch). How many do you need?";
        }
        return d.question;
    }

    /** Builds a full spec from the draft, appending each default used to {@code assumptions}. */
    public static VmSpec apply(IntentDraft d, List<String> assumptions) {
        // Size
        Integer vcpu = d.vcpu;
        Integer mem = d.memoryGiB;
        if (d.sizeClass != null && (vcpu != null || mem != null)) {
            assumptions.add("Explicit CPU/memory values take priority over '" + d.sizeClass + "'.");
        }
        if (vcpu == null && mem == null) {
            String cls = d.sizeClass != null ? d.sizeClass : "small";
            int[] s = SIZES.get(cls);
            vcpu = s[0];
            mem = s[1];
            assumptions.add((d.sizeClass != null ? "'" + cls + "'" : "No size given, so 'small'")
                    + " = " + vcpu + " vCPU / " + mem + " GiB.");
        } else if (vcpu == null) {
            vcpu = Math.max(1, mem / 4);
            assumptions.add("vCPU set to " + vcpu + " (1 vCPU per 4 GiB).");
        } else if (mem == null) {
            mem = vcpu * 4;
            assumptions.add("Memory set to " + mem + " GiB (4 GiB per vCPU).");
        }

        // Operating system
        String os = d.os;
        if (os == null) {
            os = "ubuntu";
            assumptions.add("No OS given, so Ubuntu (platform standard).");
        } else if (os.equals("linux")) {
            os = "ubuntu";
            assumptions.add("Generic 'Linux' means Ubuntu (platform standard).");
        }
        String osVersion = d.osVersion != null ? d.osVersion : OS_DEFAULT_VERSION.getOrDefault(os, "latest");
        if (d.osVersion == null) assumptions.add(cap(os) + " version " + osVersion + " (current standard).");

        // Region
        String region = d.region;
        if (region == null) {
            region = "vsphere".equals(d.provider) ? "dc1" : "us-east";
            assumptions.add("No location given, so " + region + ".");
        }

        // Disk
        int disk;
        if (d.diskGiB != null) disk = d.diskGiB;
        else {
            disk = "windows".equals(os) ? 128 : 50;
            assumptions.add("Disk " + disk + " GiB (default for " + os + ").");
        }
        String tier = d.diskTier != null ? d.diskTier : "ssd";

        // Environment and lifetime
        String env = d.env;
        if (env == null) {
            env = "dev";
            assumptions.add("Environment 'dev'.");
        }
        int ttl;
        if (d.ttlDays != null) ttl = d.ttlDays;
        else {
            ttl = TTL_BY_ENV.getOrDefault(env, 30);
            assumptions.add(ttl == 0 ? "No expiry (prod)." : "Expires after " + ttl + " days (" + env + " default).");
        }

        boolean publicIp = d.publicIp != null && d.publicIp;

        return new VmSpec(d.name, d.provider, region, vcpu, mem, os, osVersion,
                disk, tier, env, ttl, publicIp);
    }

    public static String summary(VmSpec s) {
        String where = switch (s.provider()) {
            case "vsphere" -> "vSphere " + s.region();
            case "aws" -> "AWS " + s.region();
            case "azure" -> "Azure " + s.region();
            case "gcp" -> "Google Cloud " + s.region();
            default -> s.provider() + " " + s.region();
        };
        return s.vcpu() + " vCPU / " + s.memoryGiB() + " GiB · " + cap(s.os()) + " " + s.osVersion()
                + " · " + s.diskGiB() + " GiB " + s.diskTier() + " · " + where + " · " + s.env()
                + " · " + (s.ttlDays() == 0 ? "no expiry" : "expires in " + s.ttlDays() + " days")
                + " · " + (s.publicIp() ? "public IP" : "private IP");
    }

    private static String cap(String s) {
        if (s.equals("rhel")) return "RHEL";
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }
}
