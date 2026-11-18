package com.example.vmintent.intent;

import com.example.vmintent.spec.VmNames;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A deterministic interpreter built from regular expressions and the
 * Vocabulary tables. It works with no API key, and it's the fallback when
 * the LLM is unavailable. Same text in, same draft out — every time.
 *
 * The work happens in three passes:
 *   1. normalize the text (number words, joined tokens like "rhel9",
 *      shorthand like "4c16g", codenames like "jammy")
 *   2. pull out provider size names ("m6i.xlarge") before anything else,
 *      so their words can't be misread as sizes
 *   3. match the vocabulary and the numbers
 */
public class RuleBasedIntentExtractor implements IntentExtractor {

    private static final Map<String, String> NUMBER_WORDS = Map.ofEntries(
            Map.entry("one", "1"), Map.entry("two", "2"), Map.entry("three", "3"), Map.entry("four", "4"),
            Map.entry("five", "5"), Map.entry("six", "6"), Map.entry("seven", "7"), Map.entry("eight", "8"), Map.entry("nine", "9"),
            Map.entry("ten", "10"), Map.entry("twelve", "12"), Map.entry("fourteen", "14"),
            Map.entry("sixteen", "16"), Map.entry("thirty", "30"), Map.entry("thirty-two", "32"),
            Map.entry("sixty-four", "64"));

    /** Text rewrites applied in order. Each turns a way of writing into one the matchers know. */
    private static final Map<String, String> REWRITES = new LinkedHashMap<>();
    static {
        // spelled-out sizes
        REWRITES.put("half a (?:terabyte|tb)", "500 gb");
        REWRITES.put("(?:a|one) hundred", "100");
        REWRITES.put("(?:a|one) terabyte", "1 tb");
        REWRITES.put("terabytes?", "tb");
        // durations written with "a"
        REWRITES.put("(?:a|one) week", "1 week");
        REWRITES.put("(?:a|one) day", "1 day");
        REWRITES.put("(?:a|one) month", "1 month");
        REWRITES.put("(?:a|one|1)?\\s*fortnight", " 2 weeks");
        // OS codenames
        REWRITES.put("(?:ubuntu\\s+)?jammy(?:\\s+jellyfish)?", "ubuntu 22.04");
        REWRITES.put("(?:ubuntu\\s+)?noble(?:\\s+numbat)?", "ubuntu 24.04");
        REWRITES.put("(?:ubuntu\\s+)?focal(?:\\s+fossa)?", "ubuntu 20.04");
        REWRITES.put("(?:debian\\s+)?bookworm", "debian 12");
        REWRITES.put("(?:debian\\s+)?bullseye", "debian 11");
        REWRITES.put("red hat enterprise linux", "rhel");
        REWRITES.put("rocky linux", "rocky");
        // joined tokens: rhel9, debian12, rocky9, ubuntu22
        REWRITES.put("(rhel|rocky|debian|ubuntu|centos)(\\d)", "$1 $2");
        // win2022, windows2019, win 2019
        REWRITES.put("win(?:dows)?\\s*(20\\d\\d)", "windows $1");
        REWRITES.put("ws\\s*(20\\d\\d)", "windows $1");
        // short region codes
        REWRITES.put("usw2", "us-west-2");
        REWRITES.put("use1", "us-east-1");
        REWRITES.put("use2", "us-east-2");
        REWRITES.put("euw1", "eu-west-1");
        // "8 x vCPU"
        REWRITES.put("(\\d+)\\s*x\\s*(v?\\s?cpus?|cores?)", "$1 $2");
        // "4c16g", "2c/4g", "2c 4g", "8c/32g"
        REWRITES.put("(\\d+)\\s*c\\s*[/ ,]?\\s*(\\d+)\\s*g(?:b|ib)?", "$1 cores $2 gb ram");
        // "16x64", "4x16" (cores x GB)
        REWRITES.put("(\\d+)\\s*x\\s*(\\d+)(?!\\d)(?!\\s*(?:gb|gib|g|tb))", "$1 cores $2 gb ram");
        // "2 cpus/8gb", "1cpu/2gb" read fine already; "dual"/"quad" core
        REWRITES.put("dual[- ]core", "2 cores");
        REWRITES.put("quad[- ]core", "4 cores");
        REWRITES.put("single[- ]core", "1 core");
        REWRITES.put("octa[- ]core", "8 cores");
        // lifetimes
        REWRITES.put("(\\d+)\\s*hours?", "$1 hours");
    }

    private static final Pattern NAME = Pattern.compile(
            "(?:called|named|name it|hostname)\\s+[\"']?(" + VmNames.REGEX + ")");
    private static final Pattern CPU = Pattern.compile(
            "(\\d+)\\s*-?\\s*(?:v\\s?cpus?|cpus?|vcores?|cores?|processors?|procs?)(?![a-z])");
    /** "CPU: 4", "vcpus=8", "cores: 16" */
    private static final Pattern CPU_LABEL = Pattern.compile(
            "(?<![a-z])(?:v\\s?cpus?|cpus?|vcores?|cores?|processors?)\\s*[:=]\\s*(\\d+)(?![\\d.])");
    private static final Pattern SIZE_UNIT = Pattern.compile(
            "(\\d+(?:\\.\\d+)?)\\s*(tb|tib|gb|gib|gigs?|gigabytes?|g|mb|mib|megabytes?)(?![a-z0-9])");
    private static final Pattern TTL = Pattern.compile(
            "(\\d+)\\s*-?\\s*(days?|weeks?|months?|hours)(?![a-z])");
    private static final Pattern UBUNTU_VER = Pattern.compile("ubuntu\\s*(\\d{2})(?:\\.(\\d{2}))?");
    /** A number right after the OS name is its version, unless it's really a CPU or memory count. */
    private static final String NOT_A_COUNT = "(?!\\.\\d)(?!\\d)(?!\\s*(?:v\\s?cpus?|cpus?|cores?|vcores?|processors?|gb|gib|gigs?|g(?![a-z])))";
    private static final Pattern RHEL_VER = Pattern.compile("(?:rhel|red\\s?hat)\\s*(\\d{1,2})" + NOT_A_COUNT);
    private static final Pattern ROCKY_VER = Pattern.compile("rocky\\s*(\\d{1,2})" + NOT_A_COUNT);
    private static final Pattern WIN_VER = Pattern.compile("(?<!\\d)(2016|2019|2022|2025)(?!\\d)");
    private static final Pattern DEBIAN_VER = Pattern.compile("debian\\s*(\\d{2})");

    // Provider size names
    private static final Pattern AWS_SIZE = Pattern.compile(
            "(?<![a-z0-9])([tmcr])(\\d+)([a-z]*)\\.(nano|micro|small|medium|large|xlarge|(\\d+)xlarge)(?![a-z0-9])");
    private static final Pattern AZURE_SIZE = Pattern.compile(
            "(?<![a-z0-9])standard_([bdef])(\\d+)([a-z]*)(?:_v\\d)?(?![a-z0-9])");
    private static final Pattern GCP_SIZE = Pattern.compile(
            "(?<![a-z0-9])(e2|n1|n2|n2d|c2|c3)-(standard|highmem|highcpu)-(\\d+)(?![a-z0-9])");
    private static final Pattern GCP_SHARED = Pattern.compile("(?<![a-z0-9])e2-(micro|small|medium)(?![a-z0-9])");
    /** Looks like a provider size we don't know (e.g. "x9z.huge"); we ask rather than guess. */
    private static final Pattern UNKNOWN_SIZE = Pattern.compile("(?<![a-z0-9])[a-z]\\d[a-z]*\\.[a-z0-9]+(?![a-z0-9])");
    /** "<place> region" where <place> isn't in the vocabulary. */
    private static final Pattern PLACE_REGION = Pattern.compile("(?:in|at)\\s+(?:the\\s+)?([a-z][a-z.' -]{1,30}?)'?s?\\s+region");

    /**
     * "3 web servers", "five ubuntu vms", "2x boxes": a number followed (within three words) by a word
     * for a machine. The words in between can't be units, so "16 gb ram servers" isn't 16 VMs.
     */
    private static final Pattern COUNT = Pattern.compile(
            "(?<![\\d.:/-])(?<!(?:rhel|rocky|debian|ubuntu|centos|windows|win|version|ver|v)\\s)(\\d{1,3})\\s*(?:x\\s+)?"
                    + "((?:(?!(?:gb|gib|g|gigs?|gigabytes?|tb|mb|ram|memory|cores?|v?cpus?|vcores?|disks?|days?|weeks?|months?|hours?)\\b)[a-z][a-z-]*\\s+){0,3})"
                    + "(?:vms?|virtual machines?|servers?|boxes|box|machines?|instances?|nodes?|hosts?)(?![a-z])");

    @Override
    public String name() {
        return "rules";
    }

    @Override
    public IntentDraft extract(String input) {
        IntentDraft d = new IntentDraft();
        String text = input == null ? "" : input.toLowerCase();

        // 1. Name first, then remove it so "web-01" isn't read as a size.
        Matcher nm = NAME.matcher(text);
        if (nm.find()) {
            d.name = nm.group(1);
            text = text.substring(0, nm.start()) + " " + text.substring(nm.end());
        }

        // 2. Normalize the wording.
        for (Map.Entry<String, String> e : NUMBER_WORDS.entrySet()) {
            text = text.replaceAll("(?<![a-z-])" + Pattern.quote(e.getKey()) + "(?![a-z-])", e.getValue());
        }
        for (Map.Entry<String, String> e : REWRITES.entrySet()) {
            text = text.replaceAll("(?<![a-z0-9])" + e.getKey() + "(?![a-z])", e.getValue());
        }
        // "two hundred" became "2 hundred" above; turn it into 200.
        Matcher hundred = Pattern.compile("(?<![0-9])(\\d)\\s+hundred(?![a-z])").matcher(text);
        StringBuilder sbH = new StringBuilder();
        while (hundred.find()) hundred.appendReplacement(sbH, String.valueOf(Integer.parseInt(hundred.group(1)) * 100));
        hundred.appendTail(sbH);
        text = sbH.toString();
        // Hedged words like "test-ish" or "small-ish" are too vague to set a field.
        text = text.replaceAll("(?<![a-z0-9])[a-z]+-ish(?![a-z])", " ");
        text = text.replaceAll("\\s+", " ");

        // 3. Provider size names come out first, then are blanked so "xlarge" etc. can't be re-read.
        text = readProviderSize(text, d);
        if (d.vcpu == null && UNKNOWN_SIZE.matcher(text).find()) {
            Matcher u = UNKNOWN_SIZE.matcher(text);
            u.find();
            d.question = "I don't recognise the size '" + u.group() + "'. How many vCPUs and how much memory?";
        }

        // 4. Words that map straight through the vocabulary.
        d.provider = Vocabulary.find(Vocabulary.PROVIDER_WORDS, text);
        if (d.provider == null) d.provider = Vocabulary.find(Vocabulary.REGION_IMPLIES_PROVIDER, text);
        d.region = Vocabulary.find(Vocabulary.REGION_WORDS, text);
        d.os = Vocabulary.find(Vocabulary.OS_WORDS, text);
        if (d.os == null && Vocabulary.containsWord(text, Vocabulary.GENERIC_LINUX)) d.os = Vocabulary.GENERIC_LINUX;
        if (d.sizeClass == null) d.sizeClass = Vocabulary.find(Vocabulary.SIZE_WORDS, text);
        d.env = Vocabulary.find(Vocabulary.ENV_WORDS, text);
        d.diskTier = lastTier(text);

        // A named place we don't know: ask instead of silently using the default region.
        if (d.region == null && d.question == null) {
            Matcher pr = PLACE_REGION.matcher(text);
            if (pr.find()) {
                d.question = "I don't know the region '" + pr.group(1).trim() + "'. Which location: "
                        + "US East, US West, US Central, EU West (or DC1 / DC2 on-prem)?";
            }
        }

        // 5. Numbers.
        if (d.vcpu == null) {
            Matcher cpu = CPU.matcher(text);
            if (cpu.find()) d.vcpu = Integer.parseInt(cpu.group(1));
            else {
                Matcher lab = CPU_LABEL.matcher(text);
                if (lab.find()) d.vcpu = Integer.parseInt(lab.group(1));
            }
        }
        readSizes(text, d);
        readOsVersion(text, d);
        readTtl(text, d);
        readCount(text, d);

        if (text.matches(".*(no public|internal only|private ip|private only|not public).*")) {
            d.publicIp = false;
        } else if (text.matches(".*(public ip|public-facing|public facing|internet-facing|internet facing"
                + "|publicly accessible|public address|external ip|elastic ip|reachable from the internet"
                + "|internet-accessible|internet accessible|accessible from the internet"
                + "|publicly reachable|publicly available|reachable publicly).*")
                || Vocabulary.containsWord(text, "public")) {
            d.publicIp = true;
        }
        return d;
    }

    /** Reads AWS, Azure and GCP size names into vCPU / memory and blanks them out of the text. */
    private static String readProviderSize(String text, IntentDraft d) {
        Matcher m = AWS_SIZE.matcher(text);
        if (m.find()) {
            String family = m.group(1);
            String size = m.group(4);
            int vcpu;
            double mem;
            if (family.equals("t")) {
                switch (size) {
                    case "nano" -> { vcpu = 2; mem = 0.5; }
                    case "micro" -> { vcpu = 2; mem = 1; }
                    case "small" -> { vcpu = 2; mem = 2; }
                    case "medium" -> { vcpu = 2; mem = 4; }
                    case "large" -> { vcpu = 2; mem = 8; }
                    case "xlarge" -> { vcpu = 4; mem = 16; }
                    default -> { vcpu = 4 * Integer.parseInt(m.group(5)); mem = vcpu * 4.0; }
                }
            } else {
                vcpu = switch (size) {
                    case "large" -> 2;
                    case "xlarge" -> 4;
                    case "medium" -> 1;
                    default -> m.group(5) != null ? 4 * Integer.parseInt(m.group(5)) : 2;
                };
                int ratio = switch (family) { case "c" -> 2; case "r" -> 8; default -> 4; };
                mem = vcpu * (double) ratio;
            }
            return setSize(text, m, d, vcpu, mem);
        }
        m = AZURE_SIZE.matcher(text);
        if (m.find()) {
            int vcpu = Integer.parseInt(m.group(2));
            int ratio = switch (m.group(1)) { case "e" -> 8; case "f" -> 2; case "b" -> 2; default -> 4; };
            return setSize(text, m, d, vcpu, vcpu * (double) ratio);
        }
        m = GCP_SIZE.matcher(text);
        if (m.find()) {
            int vcpu = Integer.parseInt(m.group(3));
            int ratio = switch (m.group(2)) { case "highmem" -> 8; case "highcpu" -> 1; default -> 4; };
            return setSize(text, m, d, vcpu, vcpu * (double) ratio);
        }
        m = GCP_SHARED.matcher(text);
        if (m.find()) {
            double mem = switch (m.group(1)) { case "micro" -> 1; case "small" -> 2; default -> 4; };
            return setSize(text, m, d, 2, mem);
        }
        return text;
    }

    private static String setSize(String text, Matcher m, IntentDraft d, int vcpu, double mem) {
        d.vcpu = vcpu;
        d.memoryGiB = (int) Math.max(1, Math.round(mem));
        d.notes.add("'" + m.group() + "' = " + d.vcpu + " vCPU / " + d.memoryGiB + " GiB.");
        return text.substring(0, m.start()) + " " + text.substring(m.end());
    }

    /** The LAST tier word wins, so "hdd... actually make the disk ssd" means SSD. */
    private static String lastTier(String text) {
        String found = null;
        int foundAt = -1;
        for (Map.Entry<String, String> e : Vocabulary.TIER_WORDS.entrySet()) {
            Matcher m = Pattern.compile("(?<![a-z0-9])" + Pattern.quote(e.getKey()) + "(?![a-z0-9])").matcher(text);
            while (m.find()) {
                if (m.start() > foundAt) {
                    foundAt = m.start();
                    found = e.getValue();
                }
            }
        }
        return found;
    }

    private static void readTtl(String text, IntentDraft d) {
        Matcher ttl = TTL.matcher(text);
        if (ttl.find()) {
            int n = Integer.parseInt(ttl.group(1));
            String unit = ttl.group(2);
            if (unit.startsWith("week")) d.ttlDays = n * 7;
            else if (unit.startsWith("month")) d.ttlDays = n * 30;
            else if (unit.startsWith("hour")) d.ttlDays = Math.max(1, (int) Math.ceil(n / 24.0));
            else d.ttlDays = n;
        } else if (text.matches(".*\\b(temporary|temp|throwaway|throw-away|short-lived|short lived|short-term|short term)\\b.*")) {
            d.ttlDays = 7;
        } else if (Vocabulary.containsWord(text, "permanent") || Vocabulary.containsWord(text, "long-lived")) {
            d.ttlDays = 0;
        }
    }

    /** The LAST count wins, so "3 servers... make that 5 servers" means 5. */
    private static void readCount(String text, IntentDraft d) {
        Matcher m = COUNT.matcher(text);
        while (m.find()) {
            int n = Integer.parseInt(m.group(1));
            if (n >= 1) d.count = n;
        }
    }

    /** Decides whether each "16 GB" is memory or disk by the words around it. */
    private static void readSizes(String text, IntentDraft d) {
        Matcher m = SIZE_UNIT.matcher(text);
        while (m.find()) {
            double amount = Double.parseDouble(m.group(1));
            String unit = m.group(2);
            double inGib = unit.startsWith("t") ? amount * 1024 : unit.startsWith("m") ? amount / 1024 : amount;
            int gib = (int) Math.max(1, Math.round(inGib));

            String after = text.substring(m.end(), Math.min(text.length(), m.end() + 20));
            after = after.split("[0-9,;|/]", 2)[0];
            String before = text.substring(Math.max(0, m.start() - 20), m.start());
            String[] parts = before.split("[0-9,;|/]");
            before = parts.length == 0 ? "" : parts[parts.length - 1];

            String kind = kindOf(after);
            if (kind == null) kind = kindOf(before);
            if (kind == null) {
                // No "RAM"/"disk" word nearby: terabytes, anything over 128 GiB, or a second
                // amount after memory is already known, is disk. Otherwise it's memory.
                if (unit.startsWith("t") || gib > 128 || d.memoryGiB != null) kind = "disk";
                else kind = "memory";
            }
            if (kind.equals("memory") && d.memoryGiB == null) d.memoryGiB = gib;
            else if (kind.equals("disk") && d.diskGiB == null) d.diskGiB = gib;
        }
    }

    private static String kindOf(String window) {
        if (window.matches(".*\\b(ram|memory|mem)\\b.*")) return "memory";
        if (window.matches(".*\\b(disk|storage|ssd|hdd|drive|volume|root|nvme)\\b.*")) return "disk";
        return null;
    }

    private static void readOsVersion(String text, IntentDraft d) {
        if (d.os == null) return;
        Matcher m;
        switch (d.os) {
            case "ubuntu" -> {
                m = UBUNTU_VER.matcher(text);
                if (m.find()) d.osVersion = m.group(1) + "." + (m.group(2) != null ? m.group(2) : "04");
            }
            case "rhel" -> {
                m = RHEL_VER.matcher(text);
                if (m.find()) d.osVersion = m.group(1);
            }
            case "rocky" -> {
                m = ROCKY_VER.matcher(text);
                if (m.find()) d.osVersion = m.group(1);
            }
            case "windows" -> {
                m = WIN_VER.matcher(text);
                if (m.find()) d.osVersion = m.group(1);
            }
            case "debian" -> {
                m = DEBIAN_VER.matcher(text);
                if (m.find()) d.osVersion = m.group(1);
            }
            default -> { }
        }
    }
}
