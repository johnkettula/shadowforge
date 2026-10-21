package com.example.vmintent.intent;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The synonym tables that make "Virginia", "us-east-1" and "N. Va" all mean
 * the same region. Both the rule-based and LLM interpreters run their output
 * through these, so whatever the wording, the values come out identical.
 */
public final class Vocabulary {

    private Vocabulary() {}

    public static final Map<String, String> PROVIDER_WORDS = longestFirst(Map.ofEntries(
            Map.entry("vsphere", "vsphere"), Map.entry("vmware", "vsphere"),
            Map.entry("on-prem", "vsphere"), Map.entry("on prem", "vsphere"),
            Map.entry("onprem", "vsphere"), Map.entry("on premises", "vsphere"),
            Map.entry("on-premises", "vsphere"), Map.entry("our datacenter", "vsphere"),
            Map.entry("our data center", "vsphere"), Map.entry("vcenter", "vsphere"),
            Map.entry("aws", "aws"), Map.entry("amazon", "aws"), Map.entry("ec2", "aws"),
            Map.entry("azure", "azure"), Map.entry("microsoft cloud", "azure"),
            Map.entry("gcp", "gcp"), Map.entry("google cloud", "gcp"), Map.entry("google", "gcp"),
            Map.entry("gce", "gcp"), Map.entry("compute engine", "gcp")));

    public static final Map<String, String> REGION_WORDS = longestFirst(Map.ofEntries(
            Map.entry("northern virginia", "us-east"), Map.entry("n. virginia", "us-east"),
            Map.entry("virginia", "us-east"), Map.entry("n. va", "us-east"),
            Map.entry("us-east-1", "us-east"), Map.entry("eastus", "us-east"),
            Map.entry("east us", "us-east"), Map.entry("us-east4", "us-east"),
            Map.entry("us-east", "us-east"), Map.entry("us east", "us-east"),
            Map.entry("east coast", "us-east"), Map.entry("eastern us", "us-east"),
            Map.entry("east", "us-east"),
            Map.entry("oregon", "us-west"), Map.entry("california", "us-west"),
            Map.entry("us-west-2", "us-west"), Map.entry("westus2", "us-west"),
            Map.entry("west us", "us-west"), Map.entry("us-west1", "us-west"),
            Map.entry("us-west", "us-west"), Map.entry("us west", "us-west"),
            Map.entry("west coast", "us-west"), Map.entry("western us", "us-west"),
            Map.entry("west us 2", "us-west"), Map.entry("west", "us-west"),
            Map.entry("iowa", "us-central"), Map.entry("ohio", "us-central"),
            Map.entry("us-central1", "us-central"), Map.entry("centralus", "us-central"),
            Map.entry("central us", "us-central"), Map.entry("us-central", "us-central"),
            Map.entry("midwest", "us-central"), Map.entry("us-east-2", "us-central"),
            Map.entry("central", "us-central"),
            Map.entry("ireland", "eu-west"), Map.entry("belgium", "eu-west"),
            Map.entry("europe", "eu-west"), Map.entry("eu-west-1", "eu-west"),
            Map.entry("westeurope", "eu-west"), Map.entry("west europe", "eu-west"),
            Map.entry("europe-west1", "eu-west"), Map.entry("eu-west", "eu-west"),
            Map.entry("netherlands", "eu-west"), Map.entry("amsterdam", "eu-west"),
            Map.entry("dublin", "eu-west"), Map.entry("london", "eu-west"), Map.entry("eu", "eu-west"),
            Map.entry("dc1", "dc1"), Map.entry("dc2", "dc2"),
            Map.entry("primary datacenter", "dc1"), Map.entry("secondary datacenter", "dc2"),
            Map.entry("primary data center", "dc1"), Map.entry("secondary data center", "dc2"),
            Map.entry("main datacenter", "dc1"), Map.entry("main data center", "dc1"),
            Map.entry("second datacenter", "dc2"), Map.entry("second data center", "dc2"),
            Map.entry("datacenter 1", "dc1"), Map.entry("data center 1", "dc1"),
            Map.entry("datacenter 2", "dc2"), Map.entry("data center 2", "dc2")));

    /** Provider-specific region names that also tell us the provider. */
    public static final Map<String, String> REGION_IMPLIES_PROVIDER = longestFirst(Map.ofEntries(
            Map.entry("us-east-1", "aws"), Map.entry("us-west-2", "aws"), Map.entry("eu-west-1", "aws"),
            Map.entry("eastus", "azure"), Map.entry("westus2", "azure"),
            Map.entry("centralus", "azure"), Map.entry("westeurope", "azure"),
            Map.entry("us-east4", "gcp"), Map.entry("us-west1", "gcp"),
            Map.entry("us-central1", "gcp"), Map.entry("europe-west1", "gcp"),
            Map.entry("us-east-2", "aws"),
            Map.entry("dc1", "vsphere"), Map.entry("dc2", "vsphere"),
            Map.entry("primary datacenter", "vsphere"), Map.entry("secondary datacenter", "vsphere"),
            Map.entry("primary data center", "vsphere"), Map.entry("secondary data center", "vsphere"),
            Map.entry("main datacenter", "vsphere"), Map.entry("main data center", "vsphere"),
            Map.entry("second datacenter", "vsphere"), Map.entry("second data center", "vsphere"),
            Map.entry("datacenter 1", "vsphere"), Map.entry("data center 1", "vsphere"),
            Map.entry("datacenter 2", "vsphere"), Map.entry("data center 2", "vsphere")));

    public static final Map<String, String> OS_WORDS = longestFirst(Map.ofEntries(
            Map.entry("ubuntu", "ubuntu"), Map.entry("red hat", "rhel"), Map.entry("redhat", "rhel"),
            Map.entry("rhel", "rhel"), Map.entry("windows", "windows"), Map.entry("win server", "windows"),
            Map.entry("debian", "debian"), Map.entry("rocky", "rocky")));

    /** Generic words that mean "some Linux": used only when no specific OS was named. */
    public static final String GENERIC_LINUX = "linux";

    public static final Map<String, String> SIZE_WORDS = longestFirst(Map.ofEntries(
            Map.entry("extra large", "xlarge"), Map.entry("extra-large", "xlarge"),
            Map.entry("x-large", "xlarge"), Map.entry("xlarge", "xlarge"), Map.entry("xl", "xlarge"),
            Map.entry("large", "large"), Map.entry("big", "large"), Map.entry("beefy", "large"),
            Map.entry("medium", "medium"), Map.entry("mid-size", "medium"), Map.entry("mid-sized", "medium"),
            Map.entry("moderate", "medium"),
            Map.entry("small", "small"),
            Map.entry("tiny", "xsmall"), Map.entry("micro", "xsmall"), Map.entry("little", "xsmall"),
            Map.entry("smallest", "xsmall"), Map.entry("minimal", "xsmall"), Map.entry("tiniest", "xsmall"),
            Map.entry("mid size", "medium"), Map.entry("very small", "xsmall"),
            Map.entry("extra small", "xsmall"), Map.entry("extra-small", "xsmall"),
            Map.entry("x-small", "xsmall"), Map.entry("very large", "xlarge")));

    public static final Map<String, String> ENV_WORDS = longestFirst(Map.ofEntries(
            Map.entry("production", "prod"), Map.entry("prod", "prod"),
            Map.entry("pre-prod", "staging"), Map.entry("preprod", "staging"),
            Map.entry("pre-production", "staging"), Map.entry("pre prod", "staging"),
            Map.entry("staging", "staging"), Map.entry("stage", "staging"),
            Map.entry("testing", "test"), Map.entry("test", "test"), Map.entry("qa", "test"),
            Map.entry("development", "dev"), Map.entry("dev", "dev"), Map.entry("sandbox", "dev")));

    public static final Map<String, String> TIER_WORDS = longestFirst(Map.ofEntries(
            Map.entry("ssd", "ssd"), Map.entry("nvme", "ssd"), Map.entry("premium", "ssd"),
            Map.entry("fast disk", "ssd"), Map.entry("fast storage", "ssd"),
            Map.entry("hdd", "standard"), Map.entry("spinning", "standard"),
            Map.entry("standard disk", "standard"), Map.entry("cheap storage", "standard"),
            Map.entry("cheap disk", "standard"), Map.entry("slow storage", "standard"),
            Map.entry("slow disk", "standard"), Map.entry("standard storage", "standard"),
            Map.entry("magnetic", "standard"), Map.entry("standard", "standard")));

    /** First phrase (longest first) found as a whole word in the text, mapped to its value. */
    public static String find(Map<String, String> words, String text) {
        for (Map.Entry<String, String> e : words.entrySet()) {
            if (containsWord(text, e.getKey())) return e.getValue();
        }
        return null;
    }

    /** Normalizes a single value from an LLM or legacy JSON, e.g. "us-east-1" -> "us-east". */
    public static String normalize(Map<String, String> words, String value) {
        if (value == null || value.isBlank()) return null;
        String v = value.trim().toLowerCase();
        if (words.containsValue(v)) return v;
        String found = find(words, v);
        return found != null ? found : v;
    }

    public static boolean containsWord(String text, String phrase) {
        Pattern p = Pattern.compile("(?<![a-z0-9])" + Pattern.quote(phrase) + "(?![a-z0-9])");
        Matcher m = p.matcher(text);
        return m.find();
    }

    private static Map<String, String> longestFirst(Map<String, String> m) {
        Map<String, String> out = new LinkedHashMap<>();
        m.entrySet().stream()
                .sorted(Comparator.comparingInt((Map.Entry<String, String> e) -> e.getKey().length()).reversed()
                        .thenComparing(Map.Entry::getKey))
                .forEach(e -> out.put(e.getKey(), e.getValue()));
        return out;
    }
}
