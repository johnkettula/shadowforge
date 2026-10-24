package com.example.vmintent.cel;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * A small evaluator for CEL, the Common Expression Language (https://cel.dev), as used in
 * operator-written definitions: conditions (when, until), computed inputs and blueprint rules.
 *
 * It implements the part of CEL that definitions need, with CEL's own syntax and meaning, so an
 * expression written here is also valid CEL for Google's cel-java (which this can be swapped
 * for; see docs/DEFINITIONS.md):
 *
 *   literals      1  2.5  'text'  "text"  true  false  null  [1, 2]  {'a': 1}
 *   operators     ! - * / % + - < <= > >= == != in && || ?:
 *   fields        spec.env   steps.create.vmId   params['size']
 *   functions     size(x) x.size()  has(a.b)  int(x) double(x) string(x)  type checks are by value
 *   strings       s.startsWith(t) s.endsWith(t) s.contains(t) s.matches(re)
 *                 s.lowerAscii() s.upperAscii() s.trim() s.split(sep) list.join(sep)   (CEL strings extension)
 *   macros        list.all(x, p) list.exists(x, p) list.exists_one(x, p) list.map(x, e) list.filter(x, p)
 *
 * Not included (not needed by definitions): protocol buffer messages, timestamps and durations,
 * bytes, unsigned ints, optional types.
 *
 * Expressions are compiled once (syntax and names checked, so a typo fails at publish) and then
 * evaluated against variables. Evaluation has a cost limit, and CEL has no loops other than the
 * bounded macros, so every expression ends.
 */
public final class Cel {

    /** Most evaluation steps one expression may take. */
    public static final int DEFAULT_COST_LIMIT = 10_000;

    private Cel() {}

    /** Parses and checks an expression. allowedVariables = the top-level names it may use. */
    public static Program compile(String source, Set<String> allowedVariables) {
        if (source == null || source.isBlank()) throw new CelException("empty expression", 0);
        Parser p = new Parser(source);
        Node n = p.parseExpr();
        p.expectEnd();
        check(n, allowedVariables, new HashSet0());
        return new Program(source, n);
    }

    // ------------------------------------------------------------------ compiled program

    public static final class Program {
        private final String source;
        private final Node root;

        Program(String source, Node root) {
            this.source = source;
            this.root = root;
        }

        public String source() {
            return source;
        }

        /**
         * The fields read directly from a top-level variable: for "steps.create.vmId == ''" and
         * var "steps", that's {"create"}. Used to check that a step only reads steps before it.
         */
        public Set<String> fieldsOf(String var) {
            Set<String> out = new java.util.TreeSet<>();
            collect(root, var, out);
            return out;
        }

        private static void collect(Node n, String var, Set<String> out) {
            switch (n) {
                case Select s -> {
                    if (s.operand instanceof Ident id && id.name.equals(var)) out.add(s.field);
                    collect(s.operand, var, out);
                }
                case Index i -> {
                    if (i.operand instanceof Ident id && id.name.equals(var) && i.index instanceof Lit l
                            && l.value instanceof String key) out.add(key);
                    collect(i.operand, var, out);
                    collect(i.index, var, out);
                }
                case Call c -> {
                    if (c.target != null) collect(c.target, var, out);
                    c.args.forEach(a -> collect(a, var, out));
                }
                case Unary u -> collect(u.operand, var, out);
                case Binary b -> {
                    collect(b.left, var, out);
                    collect(b.right, var, out);
                }
                case Cond c -> {
                    collect(c.test, var, out);
                    collect(c.yes, var, out);
                    collect(c.no, var, out);
                }
                case ListLit l -> l.items.forEach(x -> collect(x, var, out));
                case MapLit m -> {
                    m.keys.forEach(x -> collect(x, var, out));
                    m.values.forEach(x -> collect(x, var, out));
                }
                case Ident id -> { }
                case Lit l -> { }
            }
        }

        public Object eval(Map<String, Object> variables) {
            return eval(variables, DEFAULT_COST_LIMIT);
        }

        public Object eval(Map<String, Object> variables, int costLimit) {
            Env env = new Env(variables, costLimit);
            Object v = root.eval(env);
            if (v instanceof Err e) throw new CelException(e.message, e.pos);
            return v;
        }

        /** Evaluates and requires a true/false answer (for when, until and rules). */
        public boolean evalBool(Map<String, Object> variables) {
            Object v = eval(variables);
            if (v instanceof Boolean b) return b;
            throw new CelException("expected true or false, got " + typeName(v), 0);
        }
    }

    // ------------------------------------------------------------------ errors

    public static final class CelException extends RuntimeException {
        private final int position;

        public CelException(String message, int position) {
            super(message);
            this.position = position;
        }

        /** Character offset in the expression (0 = start). */
        public int position() {
            return position;
        }
    }

    /** An error carried as a value, so && and || can absorb it as CEL does (false && error = false). */
    record Err(String message, int pos) {}

    // ------------------------------------------------------------------ checking

    /** Small set without pulling in more imports at call sites. */
    static final class HashSet0 extends java.util.HashSet<String> {
        HashSet0() {}

        HashSet0(java.util.Collection<String> c) {
            super(c);
        }
    }

    private static final Set<String> FUNCTIONS = Set.of("size", "has", "int", "double", "string", "bool");
    private static final Set<String> METHODS = Set.of("size", "startsWith", "endsWith", "contains", "matches",
            "lowerAscii", "upperAscii", "trim", "split", "join");
    private static final Set<String> MACROS = Set.of("all", "exists", "exists_one", "map", "filter");

    private static void check(Node n, Set<String> allowed, Set<String> bound) {
        switch (n) {
            case Ident id -> {
                if (!allowed.contains(id.name) && !bound.contains(id.name)) {
                    throw new CelException("unknown name '" + id.name + "'"
                            + (allowed.isEmpty() ? "" : " (can use: " + String.join(", ", new java.util.TreeSet<>(allowed)) + ")"), id.pos);
                }
            }
            case Call c -> {
                if (c.target == null) {
                    if (!FUNCTIONS.contains(c.name)) throw new CelException("unknown function '" + c.name + "'", c.pos);
                    if (c.name.equals("has")) {
                        if (c.args.size() != 1 || !(c.args.get(0) instanceof Select)) {
                            throw new CelException("has() takes one field, like has(params.size)", c.pos);
                        }
                        check(((Select) c.args.get(0)).operand, allowed, bound);
                        return;
                    }
                    if (c.args.size() != 1) throw new CelException(c.name + "() takes one argument", c.pos);
                    c.args.forEach(a -> check(a, allowed, bound));
                } else if (MACROS.contains(c.name)) {
                    if (c.args.size() != 2 || !(c.args.get(0) instanceof Ident v)) {
                        throw new CelException(c.name + "() takes a variable name and an expression, like list.all(x, x > 0)", c.pos);
                    }
                    check(c.target, allowed, bound);
                    Set<String> inner = new HashSet0(bound);
                    inner.add(v.name);
                    check(c.args.get(1), allowed, inner);
                } else {
                    if (!METHODS.contains(c.name)) throw new CelException("unknown function '" + c.name + "'", c.pos);
                    check(c.target, allowed, bound);
                    c.args.forEach(a -> check(a, allowed, bound));
                    if (c.name.equals("matches") && c.args.size() == 1 && c.args.get(0) instanceof Lit l && l.value instanceof String re) {
                        try {
                            Pattern.compile(re);
                        } catch (PatternSyntaxException e) {
                            throw new CelException("bad regular expression: " + e.getDescription(), l.pos);
                        }
                    }
                }
            }
            case Select s -> check(s.operand, allowed, bound);
            case Index i -> {
                check(i.operand, allowed, bound);
                check(i.index, allowed, bound);
            }
            case Unary u -> check(u.operand, allowed, bound);
            case Binary b -> {
                check(b.left, allowed, bound);
                check(b.right, allowed, bound);
            }
            case Cond c -> {
                check(c.test, allowed, bound);
                check(c.yes, allowed, bound);
                check(c.no, allowed, bound);
            }
            case ListLit l -> l.items.forEach(x -> check(x, allowed, bound));
            case MapLit m -> {
                m.keys.forEach(x -> check(x, allowed, bound));
                m.values.forEach(x -> check(x, allowed, bound));
            }
            case Lit l -> { }
        }
    }

    // ------------------------------------------------------------------ evaluation environment

    static final class Env {
        final Map<String, Object> vars;
        final int limit;
        int cost;

        Env(Map<String, Object> vars, int limit) {
            this.vars = vars == null ? Map.of() : vars;
            this.limit = limit;
        }

        Env(Env parent, String name, Object value) {
            Map<String, Object> m = new HashMap<>(parent.vars);
            m.put(name, value);
            this.vars = m;
            this.limit = parent.limit;
            this.cost = parent.cost;
        }

        void tick(int pos) {
            if (++cost > limit) throw new CelException("expression is too costly (over " + limit + " steps)", pos);
        }
    }

    // ------------------------------------------------------------------ syntax tree

    sealed interface Node permits Lit, Ident, Select, Index, Call, Unary, Binary, Cond, ListLit, MapLit {
        Object eval(Env env);
    }

    record Lit(Object value, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            return value;
        }
    }

    record Ident(String name, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            if (!env.vars.containsKey(name)) return new Err("no value for '" + name + "'", pos);
            return normalize(env.vars.get(name));
        }
    }

    record Select(Node operand, String field, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            Object o = operand.eval(env);
            if (o instanceof Err) return o;
            if (o instanceof Map<?, ?> m) {
                if (!m.containsKey(field)) return new Err("no such key: '" + field + "'", pos);
                return normalize(m.get(field));
            }
            return new Err("can't read field '" + field + "' of " + typeName(o), pos);
        }
    }

    record Index(Node operand, Node index, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            Object o = operand.eval(env);
            if (o instanceof Err) return o;
            Object k = index.eval(env);
            if (k instanceof Err) return k;
            if (o instanceof List<?> l) {
                if (!(k instanceof Long i)) return new Err("a list index must be an int", pos);
                if (i < 0 || i >= l.size()) return new Err("index " + i + " out of range (size " + l.size() + ")", pos);
                return normalize(l.get(i.intValue()));
            }
            if (o instanceof Map<?, ?> m) {
                if (!m.containsKey(k)) return new Err("no such key: " + show(k), pos);
                return normalize(m.get(k));
            }
            return new Err("can't index " + typeName(o), pos);
        }
    }

    record Unary(String op, Node operand, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            Object v = operand.eval(env);
            if (v instanceof Err) return v;
            if (op.equals("!")) {
                if (v instanceof Boolean b) return !b;
                return new Err("! needs true or false, got " + typeName(v), pos);
            }
            if (v instanceof Long l) {
                if (l == Long.MIN_VALUE) return new Err("integer overflow", pos);
                return -l;
            }
            if (v instanceof Double d) return -d;
            return new Err("- needs a number, got " + typeName(v), pos);
        }
    }

    record Binary(String op, Node left, Node right, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            if (op.equals("&&") || op.equals("||")) return logic(env);
            Object a = left.eval(env);
            if (a instanceof Err) return a;
            Object b = right.eval(env);
            if (b instanceof Err) return b;
            try {
                return switch (op) {
                    case "==" -> equal(a, b);
                    case "!=" -> !equal(a, b);
                    case "<", "<=", ">", ">=" -> compare(a, b);
                    case "in" -> in(a, b);
                    case "+" -> plus(a, b);
                    case "-", "*", "/", "%" -> arith(a, b);
                    default -> new Err("unknown operator " + op, pos);
                };
            } catch (ArithmeticException e) {
                return new Err(e.getMessage(), pos);
            }
        }

        /** CEL's && and || ignore an error on one side when the other side decides the answer. */
        private Object logic(Env env) {
            boolean and = op.equals("&&");
            Object a = left.eval(env);
            if (a instanceof Boolean x && x != and) return x;    // false && _  or  true || _
            Object b = right.eval(env);
            if (b instanceof Boolean y && y != and) return y;
            if (a instanceof Err) return a;
            if (b instanceof Err) return b;
            if (!(a instanceof Boolean) || !(b instanceof Boolean)) {
                return new Err(op + " needs true or false on both sides", pos);
            }
            return and;   // both true (&&) or both false (||)
        }

        private Object compare(Object a, Object b) {
            int c;
            if (a instanceof Number x && b instanceof Number y) {
                c = Double.compare(x.doubleValue(), y.doubleValue());
                if (a instanceof Long la && b instanceof Long lb) c = Long.compare(la, lb);
            } else if (a instanceof String x && b instanceof String y) {
                c = x.compareTo(y);
            } else if (a instanceof Boolean x && b instanceof Boolean y) {
                c = Boolean.compare(x, y);
            } else {
                return new Err("can't compare " + typeName(a) + " with " + typeName(b), pos);
            }
            return switch (op) {
                case "<" -> c < 0;
                case "<=" -> c <= 0;
                case ">" -> c > 0;
                default -> c >= 0;
            };
        }

        private Object in(Object a, Object b) {
            if (b instanceof List<?> l) {
                for (Object x : l) if (equal(a, normalize(x))) return true;
                return false;
            }
            if (b instanceof Map<?, ?> m) return m.containsKey(a);
            return new Err("'in' needs a list or map on the right, got " + typeName(b), pos);
        }

        private Object plus(Object a, Object b) {
            if (a instanceof String x && b instanceof String y) return x + y;
            if (a instanceof List<?> x && b instanceof List<?> y) {
                List<Object> out = new ArrayList<>(x);
                out.addAll(y);
                return out;
            }
            return arith(a, b);
        }

        private Object arith(Object a, Object b) {
            if (a instanceof Long x && b instanceof Long y) {
                return switch (op) {
                    case "+" -> Math.addExact(x, y);
                    case "-" -> Math.subtractExact(x, y);
                    case "*" -> Math.multiplyExact(x, y);
                    case "/" -> {
                        if (y == 0) throw new ArithmeticException("division by zero");
                        yield x / y;
                    }
                    default -> {
                        if (y == 0) throw new ArithmeticException("modulus by zero");
                        yield x % y;
                    }
                };
            }
            if (a instanceof Double x && b instanceof Double y) {
                return switch (op) {
                    case "+" -> x + y;
                    case "-" -> x - y;
                    case "*" -> x * y;
                    case "/" -> x / y;
                    default -> new Err("% needs ints", pos);
                };
            }
            // CEL doesn't mix int and double in arithmetic: convert with int() or double() first.
            return new Err("no " + op + " for " + typeName(a) + " and " + typeName(b)
                    + (a instanceof Number && b instanceof Number ? " (use double() or int() to convert)" : ""), pos);
        }
    }

    record Cond(Node test, Node yes, Node no, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            Object t = test.eval(env);
            if (t instanceof Err) return t;
            if (!(t instanceof Boolean b)) return new Err("?: needs true or false before ?, got " + typeName(t), pos);
            return b ? yes.eval(env) : no.eval(env);
        }
    }

    record ListLit(List<Node> items, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            List<Object> out = new ArrayList<>(items.size());
            for (Node n : items) {
                Object v = n.eval(env);
                if (v instanceof Err) return v;
                out.add(v);
            }
            return out;
        }
    }

    record MapLit(List<Node> keys, List<Node> values, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            Map<Object, Object> out = new LinkedHashMap<>();
            for (int i = 0; i < keys.size(); i++) {
                Object k = keys.get(i).eval(env);
                if (k instanceof Err) return k;
                if (!(k instanceof String) && !(k instanceof Long) && !(k instanceof Boolean)) {
                    return new Err("a map key must be a string, int or bool", pos);
                }
                Object v = values.get(i).eval(env);
                if (v instanceof Err) return v;
                if (out.put(k, v) != null) return new Err("duplicate map key " + show(k), pos);
            }
            return out;
        }
    }

    record Call(Node target, String name, List<Node> args, int pos) implements Node {
        public Object eval(Env env) {
            env.tick(pos);
            if (target == null) return function(env);
            if (MACROS.contains(name)) return macro(env);
            Object t = target.eval(env);
            if (t instanceof Err) return t;
            List<Object> a = new ArrayList<>();
            for (Node n : args) {
                Object v = n.eval(env);
                if (v instanceof Err) return v;
                a.add(v);
            }
            return method(t, a);
        }

        private Object function(Env env) {
            if (name.equals("has")) {
                Select s = (Select) args.get(0);
                Object o = s.operand.eval(env);
                if (o instanceof Err) return o;
                if (o instanceof Map<?, ?> m) return m.containsKey(s.field);
                return new Err("has() needs a map field", pos);
            }
            Object v = args.get(0).eval(env);
            if (v instanceof Err) return v;
            return switch (name) {
                case "size" -> size(v);
                case "int" -> toInt(v);
                case "double" -> toDouble(v);
                case "string" -> v instanceof String s ? s : v == null ? new Err("string(null)", pos) : show(v).replaceAll("^'|'$", "");
                case "bool" -> v instanceof Boolean b ? b : "true".equals(v) ? Boolean.TRUE : "false".equals(v) ? Boolean.FALSE
                        : new Err("can't convert " + show(v) + " to bool", pos);
                default -> new Err("unknown function " + name, pos);
            };
        }

        private Object toInt(Object v) {
            if (v instanceof Long l) return l;
            if (v instanceof Double d) {
                if (d.isNaN() || d.isInfinite() || d > Long.MAX_VALUE || d < Long.MIN_VALUE) return new Err("int() out of range", pos);
                return (long) d.doubleValue();
            }
            if (v instanceof String s) {
                try {
                    return Long.parseLong(s.trim());
                } catch (NumberFormatException e) {
                    return new Err("can't convert '" + s + "' to int", pos);
                }
            }
            return new Err("can't convert " + typeName(v) + " to int", pos);
        }

        private Object toDouble(Object v) {
            if (v instanceof Long l) return l.doubleValue();
            if (v instanceof Double d) return d;
            if (v instanceof String s) {
                try {
                    return Double.parseDouble(s.trim());
                } catch (NumberFormatException e) {
                    return new Err("can't convert '" + s + "' to double", pos);
                }
            }
            return new Err("can't convert " + typeName(v) + " to double", pos);
        }

        private Object size(Object v) {
            if (v instanceof String s) return (long) s.codePointCount(0, s.length());
            if (v instanceof List<?> l) return (long) l.size();
            if (v instanceof Map<?, ?> m) return (long) m.size();
            return new Err("size() of " + typeName(v), pos);
        }

        private Object method(Object t, List<Object> a) {
            if (name.equals("size") && a.isEmpty()) return size(t);
            if (name.equals("join") && t instanceof List<?> l) {
                String sep = a.isEmpty() ? "" : a.get(0) instanceof String s ? s : null;
                if (sep == null) return new Err("join() needs a string separator", pos);
                StringBuilder sb = new StringBuilder();
                for (Object x : l) {
                    if (!(x instanceof String s)) return new Err("join() needs a list of strings", pos);
                    if (sb.length() > 0) sb.append(sep);
                    sb.append(s);
                }
                return sb.toString();
            }
            if (!(t instanceof String s)) return new Err(name + "() needs a string, got " + typeName(t), pos);
            return switch (name) {
                case "lowerAscii" -> s.toLowerCase(java.util.Locale.ROOT);
                case "upperAscii" -> s.toUpperCase(java.util.Locale.ROOT);
                case "trim" -> s.strip();
                default -> {
                    if (a.size() != 1 || !(a.get(0) instanceof String x)) yield new Err(name + "() needs one string argument", pos);
                    yield switch (name) {
                        case "startsWith" -> s.startsWith(x);
                        case "endsWith" -> s.endsWith(x);
                        case "contains" -> s.contains(x);
                        case "matches" -> Pattern.compile(x).matcher(s).find();   // CEL matches = RE2 search
                        case "split" -> List.of(s.split(Pattern.quote(x), -1));
                        default -> new Err("unknown function " + name, pos);
                    };
                }
            };
        }

        private Object macro(Env env) {
            Object t = target.eval(env);
            if (t instanceof Err) return t;
            if (!(t instanceof List<?> list)) return new Err(name + "() needs a list, got " + typeName(t), pos);
            String var = ((Ident) args.get(0)).name;
            Node body = args.get(1);
            List<Object> out = new ArrayList<>();
            int count = 0;
            Err firstErr = null;
            for (Object item : list) {
                Env inner = new Env(env, var, normalize(item));
                Object r = body.eval(inner);
                env.cost = inner.cost;
                switch (name) {
                    case "map" -> {
                        if (r instanceof Err) return r;
                        out.add(r);
                    }
                    case "filter" -> {
                        if (r instanceof Err) return r;
                        if (!(r instanceof Boolean)) return new Err("filter() needs true or false", pos);
                        if ((Boolean) r) out.add(normalize(item));
                    }
                    default -> {
                        if (r instanceof Err e) {
                            if (firstErr == null) firstErr = e;
                            continue;
                        }
                        if (!(r instanceof Boolean b)) return new Err(name + "() needs true or false", pos);
                        if (name.equals("all") && !b) return false;
                        if (name.equals("exists") && b) return true;
                        if (b) count++;
                    }
                }
            }
            return switch (name) {
                case "map", "filter" -> out;
                case "all" -> firstErr != null ? firstErr : (Object) true;
                case "exists" -> firstErr != null ? firstErr : (Object) false;
                default -> firstErr != null ? firstErr : (Object) (count == 1);
            };
        }
    }

    // ------------------------------------------------------------------ values

    /** Java values in, CEL values out: whole numbers become Long, others Double. */
    static Object normalize(Object v) {
        if (v instanceof Integer i) return i.longValue();
        if (v instanceof Short s) return s.longValue();
        if (v instanceof Byte b) return b.longValue();
        if (v instanceof Float f) return f.doubleValue();
        if (v instanceof java.math.BigDecimal d) return d.doubleValue();
        if (v instanceof java.math.BigInteger b) return b.longValueExact();
        if (v instanceof Enum<?> e) return e.name();
        return v;
    }

    static boolean equal(Object a, Object b) {
        a = normalize(a);
        b = normalize(b);
        if (a == null || b == null) return a == b;
        if (a instanceof Number x && b instanceof Number y) {
            if (a instanceof Long la && b instanceof Long lb) return la.equals(lb);
            return x.doubleValue() == y.doubleValue();
        }
        if (a instanceof List<?> x && b instanceof List<?> y) {
            if (x.size() != y.size()) return false;
            for (int i = 0; i < x.size(); i++) if (!equal(x.get(i), y.get(i))) return false;
            return true;
        }
        if (a instanceof Map<?, ?> x && b instanceof Map<?, ?> y) {
            if (x.size() != y.size()) return false;
            for (Map.Entry<?, ?> e : x.entrySet()) {
                if (!y.containsKey(e.getKey()) || !equal(e.getValue(), y.get(e.getKey()))) return false;
            }
            return true;
        }
        return a.getClass() == b.getClass() && a.equals(b);
    }

    static String typeName(Object v) {
        v = normalize(v);
        if (v == null) return "null";
        if (v instanceof Long) return "int";
        if (v instanceof Double) return "double";
        if (v instanceof String) return "string";
        if (v instanceof Boolean) return "bool";
        if (v instanceof List) return "list";
        if (v instanceof Map) return "map";
        return v.getClass().getSimpleName();
    }

    static String show(Object v) {
        v = normalize(v);
        if (v instanceof String s) return "'" + s + "'";
        return String.valueOf(v);
    }

    // ------------------------------------------------------------------ parser

    static final class Parser {
        private final String src;
        private int i;

        Parser(String src) {
            this.src = src;
        }

        void expectEnd() {
            skip();
            if (i < src.length()) throw err("unexpected '" + src.charAt(i) + "'");
        }

        Node parseExpr() {
            Node test = or();
            skip();
            if (peek('?')) {
                int p = i++;
                Node yes = or();
                skip();
                expect(':');
                Node no = parseExpr();
                return new Cond(test, yes, no, p);
            }
            return test;
        }

        private Node or() {
            Node l = and();
            while (true) {
                skip();
                if (!src.startsWith("||", i)) return l;
                int p = i;
                i += 2;
                l = new Binary("||", l, and(), p);
            }
        }

        private Node and() {
            Node l = relation();
            while (true) {
                skip();
                if (!src.startsWith("&&", i)) return l;
                int p = i;
                i += 2;
                l = new Binary("&&", l, relation(), p);
            }
        }

        private Node relation() {
            Node l = addition();
            while (true) {
                skip();
                int p = i;
                String op = null;
                for (String o : new String[]{"==", "!=", "<=", ">=", "<", ">"}) {
                    if (src.startsWith(o, i)) {
                        op = o;
                        break;
                    }
                }
                if (op == null && src.startsWith("in", i) && !identChar(at(i + 2))) op = "in";
                if (op == null) return l;
                i += op.length();
                l = new Binary(op, l, addition(), p);
            }
        }

        private Node addition() {
            Node l = multiplication();
            while (true) {
                skip();
                if (i >= src.length() || (src.charAt(i) != '+' && src.charAt(i) != '-')) return l;
                int p = i;
                String op = String.valueOf(src.charAt(i++));
                l = new Binary(op, l, multiplication(), p);
            }
        }

        private Node multiplication() {
            Node l = unary();
            while (true) {
                skip();
                if (i >= src.length() || "*/%".indexOf(src.charAt(i)) < 0) return l;
                int p = i;
                String op = String.valueOf(src.charAt(i++));
                l = new Binary(op, l, unary(), p);
            }
        }

        private Node unary() {
            skip();
            if (peek('!') && !src.startsWith("!=", i)) {
                int p = i++;
                return new Unary("!", unary(), p);
            }
            if (peek('-')) {
                int p = i++;
                skip();
                // A negative literal, so -9223372036854775808 parses.
                if (i < src.length() && Character.isDigit(src.charAt(i))) {
                    Node lit = number(p, true);
                    return member(lit);
                }
                return new Unary("-", unary(), p);
            }
            return member(primary());
        }

        private Node member(Node n) {
            while (true) {
                skip();
                if (peek('.')) {
                    int p = i++;
                    skip();
                    String name = ident();
                    skip();
                    if (peek('(')) {
                        n = new Call(n, name, args(')'), p);
                    } else {
                        n = new Select(n, name, p);
                    }
                } else if (peek('[')) {
                    int p = i++;
                    Node idx = parseExpr();
                    skip();
                    expect(']');
                    n = new Index(n, idx, p);
                } else {
                    return n;
                }
            }
        }

        private Node primary() {
            skip();
            if (i >= src.length()) throw err("expression ends too soon");
            int p = i;
            char c = src.charAt(i);
            if (c == '(') {
                i++;
                Node n = parseExpr();
                skip();
                expect(')');
                return n;
            }
            if (c == '[') return new ListLit(args(']'), p);
            if (c == '{') {
                i++;
                List<Node> keys = new ArrayList<>(), values = new ArrayList<>();
                skip();
                if (!peek('}')) {
                    do {
                        keys.add(parseExpr());
                        skip();
                        expect(':');
                        values.add(parseExpr());
                        skip();
                        if (peek(',')) {
                            i++;
                            skip();
                            if (peek('}')) break;   // trailing comma
                        } else {
                            break;
                        }
                    } while (true);
                }
                skip();
                expect('}');
                return new MapLit(keys, values, p);
            }
            if (c == '"' || c == '\'') return new Lit(string(), p);
            if (Character.isDigit(c)) return number(p, false);
            if (identStart(c)) {
                String name = ident();
                switch (name) {
                    case "true": return new Lit(Boolean.TRUE, p);
                    case "false": return new Lit(Boolean.FALSE, p);
                    case "null": return new Lit(null, p);
                    default: break;
                }
                skip();
                if (peek('(')) return new Call(null, name, args(')'), p);
                return new Ident(name, p);
            }
            throw err("unexpected '" + c + "'");
        }

        /** Arguments or list items, after the opening bracket. */
        private List<Node> args(char close) {
            i++;   // the opening ( or [
            List<Node> out = new ArrayList<>();
            skip();
            if (peek(close)) {
                i++;
                return out;
            }
            while (true) {
                out.add(parseExpr());
                skip();
                if (peek(',')) {
                    i++;
                    skip();
                    if (peek(close)) break;   // trailing comma
                    continue;
                }
                break;
            }
            skip();
            expect(close);
            return out;
        }

        private Node number(int p, boolean negative) {
            int start = i;
            while (i < src.length() && (Character.isDigit(src.charAt(i)))) i++;
            boolean dbl = false;
            if (i < src.length() && src.charAt(i) == '.' && i + 1 < src.length() && Character.isDigit(src.charAt(i + 1))) {
                dbl = true;
                i++;
                while (i < src.length() && Character.isDigit(src.charAt(i))) i++;
            }
            if (i < src.length() && (src.charAt(i) == 'e' || src.charAt(i) == 'E')) {
                dbl = true;
                i++;
                if (i < src.length() && (src.charAt(i) == '+' || src.charAt(i) == '-')) i++;
                while (i < src.length() && Character.isDigit(src.charAt(i))) i++;
            }
            String text = (negative ? "-" : "") + src.substring(start, i);
            try {
                return new Lit(dbl ? (Object) Double.parseDouble(text) : (Object) Long.parseLong(text), p);
            } catch (NumberFormatException e) {
                throw new CelException("number out of range: " + text, p);
            }
        }

        private String string() {
            char q = src.charAt(i++);
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= src.length()) throw err("unclosed string");
                char c = src.charAt(i++);
                if (c == q) return sb.toString();
                if (c == '\\') {
                    if (i >= src.length()) throw err("unclosed string");
                    char e = src.charAt(i++);
                    switch (e) {
                        case 'n' -> sb.append('\n');
                        case 't' -> sb.append('\t');
                        case 'r' -> sb.append('\r');
                        case '\\', '\'', '"' -> sb.append(e);
                        default -> throw err("unknown escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        private String ident() {
            if (i >= src.length() || !identStart(src.charAt(i))) throw err("expected a name");
            int s = i;
            while (i < src.length() && identChar(src.charAt(i))) i++;
            return src.substring(s, i);
        }

        private void skip() {
            while (i < src.length() && Character.isWhitespace(src.charAt(i))) i++;
        }

        private boolean peek(char c) {
            return i < src.length() && src.charAt(i) == c;
        }

        private void expect(char c) {
            if (!peek(c)) throw err("expected '" + c + "'");
            i++;
        }

        private char at(int k) {
            return k < src.length() ? src.charAt(k) : ' ';
        }

        private static boolean identStart(char c) {
            return Character.isLetter(c) || c == '_';
        }

        private static boolean identChar(char c) {
            return Character.isLetterOrDigit(c) || c == '_';
        }

        private CelException err(String message) {
            return new CelException(message + " at position " + (i + 1), i);
        }
    }
}
