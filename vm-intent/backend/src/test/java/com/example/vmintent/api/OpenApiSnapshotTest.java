package com.example.vmintent.api;

import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.core.util.Separators;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The snapshots docs/openapi.json and docs/openapi.yaml must be the document the server generates
 * (/v3/api-docs and /v3/api-docs.yaml), apart from the top-level 'servers': each snapshot keeps its own
 * local-development entry, while the generated one names the address the test fetched from.
 *
 * With -Dopenapi.write=true the test rewrites both snapshots from the generated document (keeping their
 * 'servers') and then checks them; without it, it never writes. It extends OpenApiDocumentTest only for its
 * Spring context: the configuration is the same, so Spring's test context cache reuses that context.
 */
class OpenApiSnapshotTest extends OpenApiDocumentTest {

    static final String WRITE_COMMAND = "mvn test -Dtest=OpenApiSnapshotTest -Dopenapi.write=true";

    /** Maven runs tests in backend/. */
    private static final Path JSON_SNAPSHOT = Path.of("..", "docs", "openapi.json");
    private static final Path YAML_SNAPSHOT = Path.of("..", "docs", "openapi.yaml");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());

    /** Two-space indent, "key": value, one array item per line, {} and [] when empty: the snapshot's style. */
    private static final DefaultPrettyPrinter PRETTY = new DefaultPrettyPrinter(Separators.createDefaultInstance()
            .withObjectFieldValueSpacing(Separators.Spacing.AFTER)
            .withObjectEmptySeparator("")
            .withArrayEmptySeparator(""))
            .withObjectIndenter(new DefaultIndenter("  ", "\n"))
            .withArrayIndenter(new DefaultIndenter("  ", "\n"));

    private static final Pattern PLAIN_KEY = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$-]*");

    @Test
    void snapshotsInDocsMatchTheGeneratedDocument() throws Exception {
        String generatedJson = fetch("/v3/api-docs");
        JsonNode generated = JSON.readTree(generatedJson);
        if (Boolean.getBoolean("openapi.write")) {
            write(JSON_SNAPSHOT, json(generated, JSON.readTree(read(JSON_SNAPSHOT)).get("servers")));
            write(YAML_SNAPSHOT, yaml(fetch("/v3/api-docs.yaml"), read(YAML_SNAPSHOT)));
        }
        List<String> stale = new ArrayList<>();
        for (Path file : List.of(JSON_SNAPSHOT, YAML_SNAPSHOT)) {
            ObjectMapper mapper = file == JSON_SNAPSHOT ? JSON : YAML;
            String difference = firstDifference(mapper.readTree(read(file)), generated);
            if (difference != null) stale.add("docs/" + file.getFileName() + " differs at " + difference);
        }
        assertTrue(stale.isEmpty(), "The OpenAPI snapshots are not the document the server generates "
                + "(/v3/api-docs, top-level 'servers' ignored):\n  " + String.join("\n  ", stale)
                + "\nIf the API change is intended, regenerate both snapshots from backend/ with:\n  "
                + WRITE_COMMAND + "\nand commit docs/openapi.json and docs/openapi.yaml.");
    }

    private String fetch(String path) throws Exception {
        return mvc.perform(get(path)).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    /** The generated document as docs/openapi.json text, with the snapshot's 'servers' in place of its own. */
    static String json(JsonNode generated, JsonNode snapshotServers) throws IOException {
        ObjectNode doc = generated.deepCopy();
        if (snapshotServers == null) doc.remove("servers");
        else doc.set("servers", snapshotServers);
        return JSON.writer(PRETTY).writeValueAsString(doc) + "\n";
    }

    /**
     * The generated YAML text with the snapshot's 'servers' block in place of its own. Text rather than a
     * re-serialised tree, so the file keeps springdoc's YAML style (block scalars, quoting) exactly.
     */
    static String yaml(String generated, String snapshot) {
        List<String> lines = generated.replace("\r\n", "\n").lines().toList();
        List<String> servers = topLevelBlock(snapshot.replace("\r\n", "\n").lines().toList(), "servers");
        List<String> own = topLevelBlock(lines, "servers");
        List<String> out = new ArrayList<>(lines);
        if (!own.isEmpty()) {
            int start = lines.indexOf("servers:");
            out = new ArrayList<>(lines.subList(0, start));
            out.addAll(servers);
            out.addAll(lines.subList(start + own.size(), lines.size()));
        }
        return String.join("\n", out) + "\n";
    }

    /** A top-level YAML key's line and everything under it (indented lines and '- ' list items). */
    private static List<String> topLevelBlock(List<String> lines, String key) {
        int start = lines.indexOf(key + ":");
        if (start < 0) return List.of();
        int end = start + 1;
        while (end < lines.size() && (lines.get(end).startsWith(" ") || lines.get(end).startsWith("-"))) end++;
        return lines.subList(start, end);
    }

    private static String read(Path file) throws IOException {
        return Files.readString(file, StandardCharsets.UTF_8);
    }

    /** Writes \n text with the line ends the file already has, so a checkout with CRLF sees no change. */
    private static void write(Path file, String text) throws IOException {
        boolean crlf = Files.exists(file) && read(file).contains("\r\n");
        Files.writeString(file, crlf ? text.replace("\n", "\r\n") : text, StandardCharsets.UTF_8);
    }

    /**
     * The first JSON path where the snapshot differs from the generated document, with both values, or null.
     * The top-level 'servers' doesn't count, nor does object key order; array order does. Numbers compare by
     * value (YAML and JSON parse 1.0 and 1 differently).
     */
    static String firstDifference(JsonNode snapshot, JsonNode generated) {
        ObjectNode s = snapshot.deepCopy(), g = generated.deepCopy();
        s.remove("servers");
        g.remove("servers");
        return difference(s, g, "");
    }

    private static String difference(JsonNode snapshot, JsonNode generated, String path) {
        if (snapshot.isObject() && generated.isObject()) {
            Set<String> keys = new LinkedHashSet<>();
            generated.fieldNames().forEachRemaining(keys::add);
            snapshot.fieldNames().forEachRemaining(keys::add);
            for (String key : keys) {
                String at = path.isEmpty() ? key : path + (PLAIN_KEY.matcher(key).matches() ? "." + key : "['" + key + "']");
                if (!snapshot.has(key)) return at + ": only in the generated document";
                if (!generated.has(key)) return at + ": only in the snapshot";
                String found = difference(snapshot.get(key), generated.get(key), at);
                if (found != null) return found;
            }
            return null;
        }
        if (snapshot.isArray() && generated.isArray()) {
            for (int i = 0; i < Math.min(snapshot.size(), generated.size()); i++) {
                String found = difference(snapshot.get(i), generated.get(i), path + "[" + i + "]");
                if (found != null) return found;
            }
            if (snapshot.size() == generated.size()) return null;
            return path + ": the snapshot has " + snapshot.size() + " items, the generated document " + generated.size();
        }
        if (snapshot.isNumber() && generated.isNumber()
                && snapshot.decimalValue().compareTo(generated.decimalValue()) == 0) {
            return null;
        }
        if (snapshot.equals(generated)) return null;
        return path + ": the snapshot has " + shorten(snapshot) + ", the generated document " + shorten(generated);
    }

    private static String shorten(JsonNode value) {
        String text = value.toString();
        return text.length() <= 200 ? text : text.substring(0, 200) + "...";
    }

    // The helpers on their own, without the context.

    @Test
    void firstDifferenceNamesThePathAndIgnoresServersAndKeyOrder() throws Exception {
        JsonNode snapshot = JSON.readTree("{\"servers\":[{\"url\":\"a\"}],\"paths\":{\"/api/v2/vms\":{\"get\":"
                + "{\"summary\":\"List VMs\",\"tags\":[\"a\",\"b\"],\"n\":1.0}}}}");
        assertNull(firstDifference(snapshot, YAML.readTree(
                "paths:\n  /api/v2/vms:\n    get:\n      n: 1\n      tags: [a, b]\n      summary: List VMs\nservers: []\n")));
        assertEquals("paths['/api/v2/vms'].get.summary: the snapshot has \"List VMs\", the generated document \"All VMs\"",
                firstDifference(snapshot, JSON.readTree(snapshot.toString().replace("List VMs", "All VMs"))));
        assertEquals("paths['/api/v2/vms'].get.tags[1]: the snapshot has \"b\", the generated document \"c\"",
                firstDifference(snapshot, JSON.readTree(snapshot.toString().replace("\"b\"", "\"c\""))));
        assertEquals("paths['/api/v2/vms'].get.operationId: only in the generated document",
                firstDifference(snapshot, JSON.readTree(snapshot.toString().replace("\"n\"", "\"operationId\":\"x\",\"n\""))));
    }

    @Test
    void yamlKeepsTheSnapshotsServersBlock() {
        String generated = "openapi: 3.0.1\nservers:\n- url: http://localhost\n  description: Generated server url\ntags:\n- name: x\n";
        String snapshot = "openapi: 3.0.1\r\nservers:\r\n- url: http://localhost:8080\r\n  description: Local development.\r\ntags: []\r\n";
        assertEquals("openapi: 3.0.1\nservers:\n- url: http://localhost:8080\n  description: Local development.\ntags:\n- name: x\n",
                yaml(generated, snapshot));
    }

    /** Writing the committed JSON snapshot's own tree gives the same text, so regenerating leaves no diff. */
    @Test
    void jsonWriterReproducesTheCommittedSnapshot() throws Exception {
        String committed = read(JSON_SNAPSHOT).replace("\r\n", "\n");
        JsonNode doc = JSON.readTree(committed);
        assertEquals(committed, json(doc, doc.get("servers")));
    }
}
