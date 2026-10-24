package com.example.vmintent.catalog;

import com.example.vmintent.cel.Cel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Computed values in a definition's "with" settings.
 *
 *   size: medium                          a plain value
 *   vcpu: ${ params.cores * 2 }           a whole value worked out with CEL: keeps its type (an int here)
 *   path: /data/${ params.app }/in        text with CEL inside: the results are joined as text
 *
 * Maps and lists are worked through value by value. ${ and } can't appear inside the expression's
 * own strings; write '${' as '$' + '{' if you ever need it.
 */
public final class Templates {

    private static final Pattern EXPR = Pattern.compile("\\$\\{(.*?)}");

    /** The names a definition's expressions may use. */
    public static final Set<String> VARIABLES = Set.of("params", "steps", "run");

    private Templates() {}

    /** Checks every ${ } in a value; returns problems as "where: what". */
    public static List<String> check(Object value, String where, Set<String> allowed, List<Cel.Program> out) {
        List<String> problems = new ArrayList<>();
        walk(value, where, allowed, problems, out);
        return problems;
    }

    private static void walk(Object value, String where, Set<String> allowed, List<String> problems, List<Cel.Program> out) {
        if (value instanceof String s) {
            Matcher m = EXPR.matcher(s);
            while (m.find()) {
                try {
                    out.add(Cel.compile(m.group(1), allowed));
                } catch (Cel.CelException e) {
                    problems.add(where + ": " + e.getMessage() + " in ${" + m.group(1) + "}");
                }
            }
            if (s.contains("${") && !EXPR.matcher(s).find()) problems.add(where + ": '${' without a closing '}'");
        } else if (value instanceof Map<?, ?> m) {
            m.forEach((k, v) -> walk(v, where + "." + k, allowed, problems, out));
        } else if (value instanceof List<?> l) {
            for (int i = 0; i < l.size(); i++) walk(l.get(i), where + "[" + i + "]", allowed, problems, out);
        }
    }

    /** Works out a value. Throws Cel.CelException with the expression in the message if one fails. */
    public static Object resolve(Object value, Map<String, Object> vars) {
        if (value instanceof String s) return resolveString(s, vars);
        if (value instanceof Map<?, ?> m) {
            Map<String, Object> out = new LinkedHashMap<>();
            m.forEach((k, v) -> out.put(String.valueOf(k), resolve(v, vars)));
            return out;
        }
        if (value instanceof List<?> l) {
            List<Object> out = new ArrayList<>(l.size());
            for (Object v : l) out.add(resolve(v, vars));
            return out;
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> resolveMap(Map<String, Object> with, Map<String, Object> vars) {
        return with == null ? Map.of() : (Map<String, Object>) resolve(with, vars);
    }

    private static Object resolveString(String s, Map<String, Object> vars) {
        Matcher m = EXPR.matcher(s);
        if (!m.find()) return s;
        if (m.start() == 0 && m.end() == s.length()) return eval(m.group(1), vars);   // the whole value
        StringBuilder sb = new StringBuilder();
        m.reset();
        while (m.find()) {
            Object v = eval(m.group(1), vars);
            m.appendReplacement(sb, Matcher.quoteReplacement(v == null ? "" : text(v)));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private static Object eval(String expr, Map<String, Object> vars) {
        try {
            return Cel.compile(expr, vars.keySet()).eval(vars);
        } catch (Cel.CelException e) {
            throw new Cel.CelException(e.getMessage() + " in ${" + expr + "}", e.position());
        }
    }

    private static String text(Object v) {
        if (v instanceof Double d && d == Math.rint(d) && !d.isInfinite()) return String.valueOf(d.longValue());
        return String.valueOf(v);
    }
}
