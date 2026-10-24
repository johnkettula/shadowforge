package com.example.vmintent.catalog;

import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.BlueprintRule;
import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.InputDef;
import com.example.vmintent.catalog.CatalogModels.StepDef;
import com.example.vmintent.cel.Cel;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import org.yaml.snakeyaml.error.MarkedYAMLException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Reads one YAML definition (a Provisioning definition or a Blueprint) and checks everything that
 * can be checked before it runs: names, actions and their settings, every CEL expression (syntax
 * and the names it uses), that a step only reads steps before it, and the classification code.
 *
 * All problems are reported at once, each as "where: what", so an operator can fix them in one go.
 */
public final class DefinitionParser {

    public static final String PROVISIONING = "Provisioning";
    public static final String BLUEPRINT = "Blueprint";

    static final Pattern NAME = Pattern.compile("[a-z][a-z0-9-]{1,40}");
    static final Pattern STEP_ID = Pattern.compile("[a-z][a-zA-Z0-9_]{0,30}");
    static final Pattern INPUT_NAME = Pattern.compile("[a-z][a-zA-Z0-9_]{0,30}");
    static final Set<String> INPUT_TYPES = Set.of("string", "int", "bool", "list");
    static final int MAX_STEPS = 50;
    static final int MAX_YAML_BYTES = 256 * 1024;

    /** definition or blueprint is set when there are no problems. */
    public record Result(String kind, Definition definition, Blueprint blueprint, List<String> problems) {
        public boolean ok() {
            return problems.isEmpty();
        }

        public String name() {
            return definition != null ? definition.name() : blueprint != null ? blueprint.name() : null;
        }

        public int version() {
            return definition != null ? definition.version() : blueprint != null ? blueprint.version() : 0;
        }
    }

    /** What the parser needs to know about the rest of the catalog. */
    public record Context(Predicate<String> classificationExists, Predicate<String> blueprintExists) {
        public static Context lenient() {
            return new Context(c -> true, b -> true);
        }
    }

    private DefinitionParser() {}

    public static Result parse(String yaml, Context ctx) {
        List<String> p = new ArrayList<>();
        if (yaml == null || yaml.isBlank()) return fail(null, "the file is empty");
        if (yaml.getBytes(StandardCharsets.UTF_8).length > MAX_YAML_BYTES) return fail(null, "the file is over 256 KB");
        Object root;
        try {
            LoaderOptions opts = new LoaderOptions();
            opts.setAllowDuplicateKeys(false);
            opts.setMaxAliasesForCollections(20);
            root = new Yaml(new SafeConstructor(opts)).load(yaml);
        } catch (MarkedYAMLException e) {
            return fail(null, "not valid YAML at line " + (e.getProblemMark().getLine() + 1) + ": " + e.getProblem());
        } catch (Exception e) {
            return fail(null, "not valid YAML: " + e.getMessage());
        }
        if (!(root instanceof Map<?, ?> m)) return fail(null, "the file must be a YAML map (kind: ..., name: ...)");
        Map<String, Object> doc = strMap(m);
        String kind = str(doc.get("kind"));
        String sha = sha256(yaml);
        if (PROVISIONING.equals(kind)) return provisioning(doc, sha, ctx, p);
        if (BLUEPRINT.equals(kind)) return blueprint(doc, sha, p);
        return fail(kind, "kind must be " + PROVISIONING + " or " + BLUEPRINT + (kind == null ? "" : ", not '" + kind + "'"));
    }

    // ------------------------------------------------------------------ provisioning definitions

    private static Result provisioning(Map<String, Object> doc, String sha, Context ctx, List<String> p) {
        known(doc, "", Set.of("kind", "name", "version", "description", "owner", "classification", "blueprint",
                "recovery", "inputs", "steps"), p);
        String name = name(doc, p);
        int version = version(doc, p);
        String classification = str(doc.get("classification"));
        if (classification != null && !ctx.classificationExists().test(classification)) {
            p.add("classification: '" + classification + "' isn't a known classification code");
        }
        String blueprint = str(doc.get("blueprint"));
        if (blueprint != null && !ctx.blueprintExists().test(blueprint)) {
            p.add("blueprint: there's no published blueprint called '" + blueprint + "'");
        }
        int waitHours = 72;
        if (doc.get("recovery") instanceof Map<?, ?> r) {
            Map<String, Object> rec = strMap(r);
            known(rec, "recovery", Set.of("waitHours"), p);
            waitHours = intIn(rec.get("waitHours"), "recovery.waitHours", 1, 72, 72, p);
        } else if (doc.get("recovery") != null) {
            p.add("recovery: must be a map, like  recovery: { waitHours: 24 }");
        }

        List<InputDef> inputs = inputs(doc.get("inputs"), p);
        Set<String> inputNames = new HashSet<>();
        inputs.forEach(i -> inputNames.add(i.name()));

        List<StepDef> steps = new ArrayList<>();
        Object rawSteps = doc.get("steps");
        if (!(rawSteps instanceof List<?> list) || list.isEmpty()) {
            p.add("steps: a definition needs at least one step");
        } else if (list.size() > MAX_STEPS) {
            p.add("steps: at most " + MAX_STEPS + " steps");
        } else {
            Set<String> earlier = new HashSet<>();
            for (int i = 0; i < list.size(); i++) {
                StepDef s = step(list.get(i), "steps[" + i + "]", earlier, inputNames, p);
                if (s != null) {
                    steps.add(s);
                    earlier.add(s.id());
                }
            }
        }
        if (!p.isEmpty()) return new Result(PROVISIONING, null, null, p);
        return new Result(PROVISIONING, new Definition(name, version, str(doc.get("description")), str(doc.get("owner")),
                classification, blueprint, inputs, steps, waitHours, sha), null, p);
    }

    private static List<InputDef> inputs(Object raw, List<String> p) {
        List<InputDef> out = new ArrayList<>();
        if (raw == null) return out;
        if (!(raw instanceof Map<?, ?> m)) {
            p.add("inputs: must be a map of input name to its settings, like  inputs: { app: { type: string } }");
            return out;
        }
        strMap(m).forEach((name, v) -> {
            String where = "inputs." + name;
            if (!INPUT_NAME.matcher(name).matches()) p.add(where + ": names are letters, digits and _, starting lowercase");
            Map<String, Object> s = v instanceof Map<?, ?> vm ? strMap(vm) : Map.of();
            if (!(v instanceof Map<?, ?>) && v != null) p.add(where + ": must be a map, like  { type: string, required: true }");
            known(s, where, Set.of("type", "description", "required", "default", "allowed"), p);
            String type = str(s.getOrDefault("type", "string"));
            if (!INPUT_TYPES.contains(type)) p.add(where + ".type: must be string, int, bool or list");
            Object def = s.get("default");
            if (def != null && !typeMatches(type, def)) p.add(where + ".default: isn't a " + type);
            List<Object> allowed = null;
            if (s.get("allowed") instanceof List<?> a) {
                allowed = new ArrayList<>(a);
                for (Object x : allowed) if (!typeMatches(type, x)) p.add(where + ".allowed: " + x + " isn't a " + type);
                if (def != null && !allowed.contains(def)) p.add(where + ".default: isn't one of the allowed values");
            } else if (s.get("allowed") != null) {
                p.add(where + ".allowed: must be a list");
            }
            boolean required = Boolean.TRUE.equals(s.get("required"));
            if (required && def != null) p.add(where + ": an input with a default can't also be required");
            out.add(new InputDef(name, type, str(s.get("description")), required, def, allowed));
        });
        return out;
    }

    static boolean typeMatches(String type, Object v) {
        return switch (type) {
            case "int" -> v instanceof Integer || v instanceof Long;
            case "bool" -> v instanceof Boolean;
            case "list" -> v instanceof List;
            default -> v instanceof String;
        };
    }

    private static StepDef step(Object raw, String where, Set<String> earlier, Set<String> inputNames, List<String> p) {
        if (!(raw instanceof Map<?, ?> m)) {
            p.add(where + ": each step must be a map with id and action");
            return null;
        }
        Map<String, Object> s = strMap(m);
        known(s, where, Set.of("id", "action", "title", "when", "with", "attempts", "timeoutMinutes"), p);
        String id = str(s.get("id"));
        if (id == null || !STEP_ID.matcher(id).matches()) {
            p.add(where + ".id: needs an id of letters, digits and _, starting lowercase (later steps read it as steps.<id>)");
            id = "step" + where.replaceAll("\\D", "");
        } else if (earlier.contains(id)) {
            p.add(where + ".id: '" + id + "' is used by an earlier step");
        }
        where = "steps." + id;
        String action = str(s.get("action"));
        Actions.Action a = action == null ? null : Actions.ALL.get(action);
        if (a == null) {
            p.add(where + ".action: " + (action == null ? "missing" : "'" + action + "' isn't an action")
                    + " (actions: " + String.join(", ", Actions.ALL.keySet()) + ")");
        }
        Map<String, Object> with = new LinkedHashMap<>();
        if (s.get("with") instanceof Map<?, ?> w) with = strMap(w);
        else if (s.get("with") != null) p.add(where + ".with: must be a map of settings");

        List<Cel.Program> programs = new ArrayList<>();
        if (a != null) {
            for (String req : a.required()) if (!with.containsKey(req)) p.add(where + ".with." + req + ": " + action + " needs it");
            for (String k : with.keySet()) {
                if (!a.required().contains(k) && !a.optional().contains(k)) {
                    Set<String> all = new java.util.TreeSet<>(a.required());
                    all.addAll(a.optional());
                    p.add(where + ".with." + k + ": " + action + " has no setting '" + k + "' (it takes: " + String.join(", ", all) + ")");
                }
            }
            if (action.equals("check.until")) {
                Object until = with.get("until");
                if (!(until instanceof String u) || u.contains("${")) {
                    p.add(where + ".with.until: a CEL condition on probe, written without ${ }, like  probe.reachable && 'nginx' in probe.tools");
                } else {
                    try {
                        programs.add(Cel.compile(u, Set.of("params", "steps", "run", "probe")));
                    } catch (Cel.CelException e) {
                        p.add(where + ".with.until: " + e.getMessage());
                    }
                }
                Map<String, Object> rest = new LinkedHashMap<>(with);
                rest.remove("until");
                p.addAll(Templates.check(rest, where + ".with", Templates.VARIABLES, programs));
            } else {
                p.addAll(Templates.check(with, where + ".with", Templates.VARIABLES, programs));
            }
            if (action.equals("approval.wait") && with.get("approvers") != null && !(with.get("approvers") instanceof List)
                    && !(with.get("approvers") instanceof String str && str.contains("${"))) {
                p.add(where + ".with.approvers: a list of user names, like  [alice, bob]");
            }
        }
        String when = str(s.get("when"));
        if (when != null) {
            try {
                programs.add(Cel.compile(when, Templates.VARIABLES));
            } catch (Cel.CelException e) {
                p.add(where + ".when: " + e.getMessage());
            }
        }
        for (Cel.Program prog : programs) {
            for (String ref : prog.fieldsOf("steps")) {
                if (!earlier.contains(ref)) {
                    p.add(where + ": reads steps." + ref + ", which isn't an earlier step (" + prog.source() + ")");
                }
            }
            for (String ref : prog.fieldsOf("params")) {
                if (!inputNames.contains(ref)) {
                    p.add(where + ": reads params." + ref + ", which isn't one of the inputs (" + prog.source() + ")");
                }
            }
        }
        int attempts = intIn(s.get("attempts"), where + ".attempts", 1, 10, 3, p);
        int timeout = intIn(s.get("timeoutMinutes"), where + ".timeoutMinutes", 1, 1440, 30, p);
        return new StepDef(id, action, str(s.get("title")), when, with, attempts, timeout);
    }

    // ------------------------------------------------------------------ blueprints

    static final Set<String> BLUEPRINT_VARS = Set.of("spec", "params", "run");

    private static Result blueprint(Map<String, Object> doc, String sha, List<String> p) {
        known(doc, "", Set.of("kind", "name", "version", "description", "appliesWhen", "rules"), p);
        String name = name(doc, p);
        int version = version(doc, p);
        String applies = str(doc.get("appliesWhen"));
        if (applies != null) compile(applies, "appliesWhen", p);
        List<BlueprintRule> rules = new ArrayList<>();
        if (!(doc.get("rules") instanceof List<?> list) || list.isEmpty()) {
            p.add("rules: a blueprint needs at least one rule");
        } else {
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < list.size(); i++) {
                String where = "rules[" + i + "]";
                if (!(list.get(i) instanceof Map<?, ?> rm)) {
                    p.add(where + ": each rule needs name, check and message");
                    continue;
                }
                Map<String, Object> r = strMap(rm);
                known(r, where, Set.of("name", "check", "message"), p);
                String rn = str(r.get("name"));
                if (rn == null || !NAME.matcher(rn).matches()) p.add(where + ".name: lowercase letters, digits and dashes");
                else if (!seen.add(rn)) p.add(where + ".name: '" + rn + "' is used twice");
                String check = str(r.get("check"));
                if (check == null) p.add(where + ".check: the CEL condition a spec must pass");
                else compile(check, where + ".check", p);
                String msg = str(r.get("message"));
                if (msg == null) p.add(where + ".message: what to tell someone whose VM fails the rule");
                rules.add(new BlueprintRule(rn, check, msg));
            }
        }
        if (!p.isEmpty()) return new Result(BLUEPRINT, null, null, p);
        return new Result(BLUEPRINT, null, new Blueprint(name, version, str(doc.get("description")), applies, rules, sha), p);
    }

    private static void compile(String expr, String where, List<String> p) {
        try {
            Cel.compile(expr, BLUEPRINT_VARS);
        } catch (Cel.CelException e) {
            p.add(where + ": " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String name(Map<String, Object> doc, List<String> p) {
        String name = str(doc.get("name"));
        if (name == null || !NAME.matcher(name).matches()) {
            p.add("name: 2-41 lowercase letters, digits and dashes, starting with a letter");
        }
        return name;
    }

    private static int version(Map<String, Object> doc, List<String> p) {
        Object v = doc.get("version");
        if (!(v instanceof Integer i) || i < 1) {
            p.add("version: a whole number, 1 or more (raise it each time you publish)");
            return 0;
        }
        return i;
    }

    private static int intIn(Object v, String where, int min, int max, int dflt, List<String> p) {
        if (v == null) return dflt;
        if (!(v instanceof Integer i) || i < min || i > max) {
            p.add(where + ": a whole number from " + min + " to " + max);
            return dflt;
        }
        return i;
    }

    private static void known(Map<String, Object> m, String where, Set<String> allowed, List<String> p) {
        for (String k : m.keySet()) {
            if (!allowed.contains(k)) {
                p.add((where.isEmpty() ? "" : where + ".") + k + ": not a setting here (expected: "
                        + String.join(", ", new java.util.TreeSet<>(allowed)) + ")");
            }
        }
    }

    static Map<String, Object> strMap(Map<?, ?> m) {
        Map<String, Object> out = new LinkedHashMap<>();
        m.forEach((k, v) -> out.put(String.valueOf(k), v));
        return out;
    }

    private static String str(Object o) {
        if (o == null) return null;
        String s = String.valueOf(o).trim();
        return s.isEmpty() ? null : s;
    }

    private static Result fail(String kind, String problem) {
        return new Result(kind, null, null, List.of(problem));
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
