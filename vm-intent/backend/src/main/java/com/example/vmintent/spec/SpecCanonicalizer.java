package com.example.vmintent.spec;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;

/**
 * Turns a spec into one exact string (keys sorted, values normalized) and
 * hashes it. Two requests that mean the same thing get the same hash, and
 * that hash becomes the Temporal workflow ID — so duplicates collapse.
 */
public final class SpecCanonicalizer {

    private SpecCanonicalizer() {}

    public static String canonicalString(VmSpec s) {
        Map<String, Object> m = new TreeMap<>();   // TreeMap = keys always sorted
        if (s.name() != null) m.put("name", s.name());
        m.put("provider", s.provider());
        m.put("region", s.region());
        m.put("vcpu", s.vcpu());
        m.put("memoryGiB", s.memoryGiB());
        m.put("os", s.os());
        m.put("osVersion", s.osVersion());
        m.put("diskGiB", s.diskGiB());
        m.put("diskTier", s.diskTier());
        m.put("env", s.env());
        m.put("ttlDays", s.ttlDays());
        m.put("publicIp", s.publicIp());

        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(e.getKey()).append("\":");
            Object v = e.getValue();
            if (v instanceof String str) sb.append('"').append(str).append('"');
            else sb.append(v);
        }
        return sb.append('}').toString();
    }

    public static String hash(VmSpec s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(canonicalString(s).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** If the user gave no name, derive a stable one from the hash. */
    public static VmSpec withGeneratedName(VmSpec s, String hash) {
        return s.name() != null ? s : s.withName("vm-" + hash.substring(0, 8));
    }
}
