package com.example.vmintent.catalog;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DefinitionParserTest {

    private static final DefinitionParser.Context CTX = new DefinitionParser.Context(
            Set.of("C1", "C3", "C5")::contains, Set.of("standard-vm", "production-guardrails")::contains);

    static String resource(String name) throws IOException {
        try (InputStream in = DefinitionParserTest.class.getResourceAsStream("/catalog/" + name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void builtInExamplesAreValid() throws IOException {
        for (String f : List.of("web-server.yaml", "monitoring-agent.yaml", "blueprint-standard-vm.yaml",
                "blueprint-production-guardrails.yaml")) {
            DefinitionParser.Result r = DefinitionParser.parse(resource(f), CTX);
            assertTrue(r.ok(), f + ": " + r.problems());
        }
        DefinitionParser.Result web = DefinitionParser.parse(resource("web-server.yaml"), CTX);
        assertEquals("web-server", web.definition().name());
        assertEquals(6, web.definition().steps().size());
        assertEquals("C3", web.definition().classification());
        assertEquals(30 * 24, web.definition().recoveryWaitHours());
        assertEquals(64, web.definition().sourceSha256().length());
    }

    @Test
    void reportsEveryProblemAtOnce() {
        String yaml = """
                kind: Provisioning
                name: Bad_Name
                version: 0
                classification: SECRET
                blueprint: nope
                recovery: { waitDays: 31 }
                inputs:
                  size: { type: string, default: 3 }
                steps:
                  - id: create
                    action: vm.creat
                  - id: copy
                    action: files.copy
                    with:
                      vm: ${ steps.later.specHash }
                      files: [a]
                      to: /x
                      mode: fast
                  - id: copy
                    action: tools.stage
                    when: "params.sise == 'big'"
                    with: { vm: "${ steps.create.specHash ", bundle: b, version: "1" }
                  - id: check
                    action: check.until
                    with: { vm: x, until: "probe.ready &&" }
                """;
        DefinitionParser.Result r = DefinitionParser.parse(yaml, CTX);
        assertFalse(r.ok());
        String all = String.join("\n", r.problems());
        for (String expected : List.of("name:", "version:", "classification: 'SECRET'", "blueprint:", "recovery.waitDays",
                "inputs.size.default", "vm.creat", "reads steps.later", "has no setting 'mode'", "used by an earlier step",
                "reads params.sise", "without a closing", "with.until")) {
            assertTrue(all.contains(expected), "expected a problem about " + expected + " in:\n" + all);
        }
    }

    @Test
    void stepsMayOnlyReadEarlierSteps() {
        String yaml = """
                kind: Provisioning
                name: order
                version: 1
                steps:
                  - id: a
                    action: config.apply
                    with: { vm: "${ steps.b.specHash }", settings: { x: 1 } }
                  - id: b
                    action: vm.create
                    with: { provider: aws, region: us-east, os: ubuntu }
                """;
        DefinitionParser.Result r = DefinitionParser.parse(yaml, CTX);
        assertEquals(1, r.problems().size(), r.problems().toString());
        assertTrue(r.problems().get(0).contains("steps.b"));
    }

    @Test
    void blueprintRulesAreCheckedCel() {
        DefinitionParser.Result r = DefinitionParser.parse("""
                kind: Blueprint
                name: bp
                version: 1
                rules:
                  - name: ok
                    check: "spec.vcpu >= 2"
                    message: fine
                  - name: typo
                    check: "spec.vcpu >= "
                    message: broken
                  - name: unknown
                    check: "steps.x == 1"
                    message: steps aren't known to blueprints
                """, CTX);
        assertEquals(2, r.problems().size(), r.problems().toString());
    }

    @Test
    void notYamlOrWrongKind() {
        assertFalse(DefinitionParser.parse("kind: [unclosed", CTX).ok());
        assertTrue(DefinitionParser.parse("kind: Pipeline\nname: x", CTX).problems().get(0).contains("kind must be"));
        assertTrue(DefinitionParser.parse("- a\n- b", CTX).problems().get(0).contains("YAML map"));
        assertTrue(DefinitionParser.parse("kind: Blueprint\nname: a\nname: b", CTX).problems().get(0).contains("YAML"));
    }

    @Test
    void templatesKeepTypesAndJoinText() {
        Map<String, Object> vars = Map.of("params", Map.of("cores", 2, "app", "shop"), "steps", Map.of(), "run", Map.of());
        assertEquals(4L, Templates.resolve("${ params.cores * 2 }", vars));
        assertEquals("/srv/shop/in", Templates.resolve("/srv/${ params.app }/in", vars));
        assertEquals(Map.of("a", List.of("shop-1")), Templates.resolve(Map.of("a", List.of("${ params.app }-1")), vars));
        assertEquals("plain", Templates.resolve("plain", vars));
    }
}
