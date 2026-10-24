package com.example.vmintent.catalog;

import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.InputDef;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Checks a run's inputs against its definition, fills in defaults, and works out the run's ID. */
public final class RunInputs {

    private static final ObjectMapper CANONICAL = new ObjectMapper().configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    public record Checked(Map<String, Object> params, List<String> problems) {}

    private RunInputs() {}

    public static Checked check(Definition def, Map<String, Object> given) {
        Map<String, Object> in = given == null ? Map.of() : given;
        List<String> problems = new ArrayList<>();
        Map<String, Object> out = new LinkedHashMap<>();
        for (String k : in.keySet()) {
            if (def.inputs().stream().noneMatch(i -> i.name().equals(k))) {
                problems.add(k + ": " + def.name() + " has no input called '" + k + "'"
                        + (def.inputs().isEmpty() ? "" : " (inputs: " + String.join(", ", def.inputs().stream().map(InputDef::name).toList()) + ")"));
            }
        }
        for (InputDef i : def.inputs()) {
            Object v = in.get(i.name());
            if (v == null || (v instanceof String s && s.isBlank())) {
                if (i.required()) problems.add(i.name() + ": required" + (i.description() == null ? "" : " (" + i.description() + ")"));
                else if (i.defaultValue() != null) out.put(i.name(), i.defaultValue());
                continue;
            }
            Object typed = coerce(i.type(), v);
            if (typed == null) {
                problems.add(i.name() + ": must be " + article(i.type()) + ", not '" + v + "'");
                continue;
            }
            if (i.allowed() != null && !i.allowed().isEmpty() && i.allowed().stream().noneMatch(a -> same(a, typed))) {
                problems.add(i.name() + ": must be one of " + i.allowed());
                continue;
            }
            out.put(i.name(), typed);
        }
        return new Checked(out, problems);
    }

    /** "run-<definition>-<12 hex>": the same definition version and inputs always give the same ID. */
    public static String runId(Definition def, Map<String, Object> params) {
        try {
            String canonical = def.name() + "|" + def.version() + "|" + CANONICAL.writeValueAsString(new TreeMap<>(params));
            String hex = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
            return "run-" + def.name() + "-" + hex.substring(0, 12);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Object coerce(String type, Object v) {
        return switch (type) {
            case "int" -> {
                if (v instanceof Integer || v instanceof Long) yield ((Number) v).longValue();
                if (v instanceof String s && s.trim().matches("-?\\d{1,18}")) yield Long.parseLong(s.trim());
                yield null;
            }
            case "bool" -> {
                if (v instanceof Boolean) yield v;
                if ("true".equalsIgnoreCase(String.valueOf(v)) || "false".equalsIgnoreCase(String.valueOf(v))) {
                    yield Boolean.parseBoolean(String.valueOf(v));
                }
                yield null;
            }
            case "list" -> v instanceof List<?> l ? new ArrayList<>(l) : null;
            default -> v instanceof String || v instanceof Number || v instanceof Boolean ? String.valueOf(v).trim() : null;
        };
    }

    private static boolean same(Object a, Object b) {
        if (a instanceof Number x && b instanceof Number y) return x.longValue() == y.longValue();
        return String.valueOf(a).equals(String.valueOf(b));
    }

    private static String article(String type) {
        return switch (type) {
            case "int" -> "a whole number";
            case "bool" -> "true or false";
            case "list" -> "a list";
            default -> "text";
        };
    }
}
