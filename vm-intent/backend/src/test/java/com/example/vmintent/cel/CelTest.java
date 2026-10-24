package com.example.vmintent.cel;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CelTest {

    private static final Set<String> VARS = Set.of("spec", "params", "steps", "run");

    private static final Map<String, Object> ENV = Map.of(
            "spec", Map.of("env", "prod", "vcpu", 4, "memoryGiB", 16, "provider", "aws", "name", "web-01",
                    "tags", Map.of("team", "payments")),
            "params", Map.of("size", "medium", "copies", 3, "files", List.of("a.tar", "b.tar"), "ratio", 0.5),
            "steps", Map.of("create", Map.of("vmId", "i-123", "ipAddress", "10.0.0.5", "ok", true)),
            "run", Map.of("requestedBy", "jdoe", "classification", "C3"));

    private static Object eval(String expr) {
        return Cel.compile(expr, VARS).eval(ENV);
    }

    @Test
    void arithmeticAndComparison() {
        assertEquals(7L, eval("1 + 2 * 3"));
        assertEquals(9L, eval("(1 + 2) * 3"));
        assertEquals(1L, eval("7 % 3"));
        assertEquals(2L, eval("7 / 3"));
        assertEquals(1.25, eval("2.5 / 2.0"));
        assertEquals(-4L, eval("-spec.vcpu"));
        assertEquals(true, eval("spec.vcpu * 4 == spec.memoryGiB"));
        assertEquals(true, eval("'abc' < 'abd'"));
        assertEquals(true, eval("1 == 1.0"));   // CEL compares numbers across types
    }

    @Test
    void cel_doesNotMixIntAndDoubleInArithmetic() {
        assertThrows(Cel.CelException.class, () -> eval("1 + 1.5"));
        assertEquals(2.5, eval("double(1) + 1.5"));
        assertEquals(1L, eval("int(params.ratio * 2.0)"));
    }

    @Test
    void fieldsIndexesAndMembership() {
        assertEquals("prod", eval("spec.env"));
        assertEquals("medium", eval("params['size']"));
        assertEquals("b.tar", eval("params.files[1]"));
        assertEquals("payments", eval("spec.tags.team"));
        assertEquals(true, eval("spec.env in ['prod', 'staging']"));
        assertEquals(true, eval("'size' in params"));
        assertEquals(true, eval("has(params.size)"));
        assertEquals(false, eval("has(params.owner)"));
        assertEquals("i-123", eval("steps.create.vmId"));
    }

    @Test
    void logicAbsorbsErrorsTheWayCelDoes() {
        assertEquals(false, eval("false && params.missing == 1"));
        assertEquals(true, eval("true || params.missing == 1"));
        assertEquals(false, eval("params.missing == 1 && false"));   // commutative in CEL
        assertEquals(true, eval("params.missing == 1 || true"));
        assertThrows(Cel.CelException.class, () -> eval("params.missing == 1 && true"));
        assertEquals("small", eval("has(params.tier) ? params.tier : 'small'"));
    }

    @Test
    void stringsAndLists() {
        assertEquals(true, eval("spec.name.startsWith('web-')"));
        assertEquals(true, eval("spec.name.matches('^web-[0-9]+$')"));
        assertEquals("WEB-01", eval("spec.name.upperAscii()"));
        assertEquals(List.of("web", "01"), eval("spec.name.split('-')"));
        assertEquals("a.tar,b.tar", eval("params.files.join(',')"));
        assertEquals(2L, eval("size(params.files)"));
        assertEquals(6L, eval("spec.name.size()"));
        assertEquals("/data/" + "web-01", eval("'/data/' + spec.name"));
        assertEquals("4", eval("string(spec.vcpu)"));
        assertEquals(List.of(1L, 2L, 3L), eval("[1, 2] + [3]"));
    }

    @Test
    void macros() {
        assertEquals(true, eval("params.files.all(f, f.endsWith('.tar'))"));
        assertEquals(true, eval("params.files.exists(f, f == 'a.tar')"));
        assertEquals(true, eval("params.files.exists_one(f, f.startsWith('b'))"));
        assertEquals(List.of("/in/a.tar", "/in/b.tar"), eval("params.files.map(f, '/in/' + f)"));
        assertEquals(List.of("b.tar"), eval("params.files.filter(f, f != 'a.tar')"));
        assertEquals(Map.of("x", 1L), eval("{'x': 1}"));
    }

    @Test
    void compileCatchesTyposAndUnknownNames() {
        Cel.CelException e = assertThrows(Cel.CelException.class, () -> Cel.compile("sepc.env == 'prod'", VARS));
        assertTrue(e.getMessage().contains("unknown name 'sepc'"), e.getMessage());
        assertThrows(Cel.CelException.class, () -> Cel.compile("spec.env ==", VARS));
        assertThrows(Cel.CelException.class, () -> Cel.compile("spec.env = 'prod'", VARS));
        assertThrows(Cel.CelException.class, () -> Cel.compile("launch(spec)", VARS));
        assertThrows(Cel.CelException.class, () -> Cel.compile("spec.name.matches('[')", VARS));
        assertThrows(Cel.CelException.class, () -> Cel.compile("'unclosed", VARS));
        assertThrows(Cel.CelException.class, () -> Cel.compile("", VARS));
        // a macro's own variable is fine inside it, and only there
        Cel.compile("params.files.all(f, f != '')", VARS);
        assertThrows(Cel.CelException.class, () -> Cel.compile("params.files.all(f, true) && f == ''", VARS));
    }

    @Test
    void runtimeErrorsAreClear() {
        Cel.CelException e = assertThrows(Cel.CelException.class, () -> eval("params.files[5]"));
        assertTrue(e.getMessage().contains("out of range"));
        assertThrows(Cel.CelException.class, () -> eval("1 / 0"));
        assertThrows(Cel.CelException.class, () -> eval("9223372036854775807 + 1"));
        assertThrows(Cel.CelException.class, () -> Cel.compile("spec.vcpu", VARS).evalBool(ENV));
    }

    @Test
    void costLimitStopsRunawayExpressions() {
        Cel.Program p = Cel.compile("params.files.map(a, params.files.map(b, params.files.map(c, a + b + c)))", VARS);
        assertEquals(2, ((List<?>) p.eval(ENV)).size());   // runs within the default limit
        Cel.CelException e = assertThrows(Cel.CelException.class, () -> p.eval(ENV, 20));
        assertTrue(e.getMessage().contains("too costly"));
    }

    @Test
    void conditionsUsedByDefinitions() {
        assertTrue(Cel.compile("spec.env == 'prod' && run.classification in ['C3', 'C5']", VARS).evalBool(ENV));
        assertFalse(Cel.compile("steps.create.ok && spec.provider == 'gcp'", VARS).evalBool(ENV));
    }
}
