package com.example.vmintent.api;

import com.example.vmintent.audit.ArchiveStore;
import com.example.vmintent.audit.DecisionLog;
import com.example.vmintent.audit.PolicyEngine;
import com.example.vmintent.audit.ReplayService;
import com.example.vmintent.catalog.ClassificationCatalog;
import com.example.vmintent.catalog.DefinitionCatalog;
import com.example.vmintent.config.OpenApiConfig;
import com.example.vmintent.config.SearchAttributesSetup;
import com.example.vmintent.db.AuditLog;
import com.example.vmintent.db.BatchStore;
import com.example.vmintent.db.InventoryActivitiesImpl;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.legacy.LegacySpecTranslator;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.security.SecurityOpenApi;
import com.example.vmintent.security.SecurityProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.client.WorkflowClient;
import org.junit.jupiter.api.Test;
import org.springdoc.core.configuration.SpringDocConfiguration;
import org.springdoc.core.properties.SpringDocConfigProperties;
import org.springdoc.webmvc.core.configuration.SpringDocWebMvcConfiguration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Checks the OpenAPI document the server publishes at /v3/api-docs, in mvn test rather than on staging.
 * Every 2xx response of every operation must be a named schema ($ref), an array of them, or a plain
 * value: a controller that returns Map&lt;String,Object&gt; is documented as a free-form map, and real
 * responses then fail validation against the document. Return a named record instead.
 *
 * The context is the web layer only: all api controllers (collaborators mocked), springdoc, and the
 * same OpenApiConfig and SecurityOpenApi customizers the server uses. No Temporal, no database.
 * OpenApiSnapshotTest extends this class to reuse the context; keep its configuration here.
 */
@WebMvcTest
@AutoConfigureMockMvc(addFilters = false)
@ImportAutoConfiguration({SpringDocConfiguration.class, SpringDocConfigProperties.class, SpringDocWebMvcConfiguration.class})
@Import({OpenApiConfig.class, SecurityOpenApi.class})
@EnableConfigurationProperties(SecurityProperties.class)
class OpenApiDocumentTest {

    /**
     * "operationId status" of 2xx responses that may stay untyped, each with its reason. Keep it short:
     * prefer a named record. An entry that no longer breaks the rule fails the test, so the list can't go stale.
     */
    private static final Map<String, String> ALLOWED = Map.of(
            // An archived file sent back byte for byte: a Temporal workflow history in Temporal's own JSON
            // format (temporal workflow show --output json), which vm-intent doesn't define.
            "downloadArchivedHistory 200", "a stored Temporal history file, passed through unchanged");

    private static final Set<String> HTTP_METHODS = Set.of("get", "put", "post", "delete", "options", "head", "patch", "trace");

    @Autowired MockMvc mvc;

    @MockitoBean WorkflowClient workflowClient;
    @MockitoBean IntentInterpreter interpreter;
    @MockitoBean VmRegistry registry;
    @MockitoBean BatchStore batches;
    @MockitoBean DefinitionCatalog definitions;
    @MockitoBean ClassificationCatalog classifications;
    @MockitoBean SearchAttributesSetup searchAttributes;
    @MockitoBean PolicyEngine policy;
    @MockitoBean DecisionLog decisions;
    @MockitoBean JdbcClient jdbc;
    @MockitoBean ReplayService replays;
    @MockitoBean ArchiveStore archive;
    @MockitoBean LegacySpecTranslator legacy;
    @MockitoBean AuditLog audit;
    @MockitoBean InventoryActivitiesImpl inventory;
    @MockitoBean VsphereRoutes routes;

    @Test
    void no2xxResponseIsAFreeFormMapOrAnUntypedObject() throws Exception {
        String body = mvc.perform(get("/v3/api-docs")).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        JsonNode doc = new ObjectMapper().readTree(body);
        Set<String> operationIds = new TreeSet<>();
        Set<String> untyped = new TreeSet<>();
        List<String> broken = new ArrayList<>();
        doc.path("paths").fields().forEachRemaining(path -> path.getValue().fields().forEachRemaining(method -> {
            if (!HTTP_METHODS.contains(method.getKey())) return;
            JsonNode op = method.getValue();
            String id = op.path("operationId").asText(method.getKey().toUpperCase() + " " + path.getKey());
            operationIds.add(id);
            op.path("responses").fields().forEachRemaining(response -> {
                if (!response.getKey().startsWith("2")) return;
                response.getValue().path("content").fields().forEachRemaining(media -> {
                    String problem = problem(media.getValue().path("schema"));
                    if (problem == null) return;
                    String key = id + " " + response.getKey();
                    untyped.add(key);
                    if (!ALLOWED.containsKey(key)) {
                        broken.add(key + " (" + method.getKey().toUpperCase() + " " + path.getKey() + ", "
                                + media.getKey() + "): " + problem);
                    }
                });
            });
        }));

        for (String expected : List.of("getVsphereBlueprint", "listClassifications", "getVsphereStatus")) {
            assertTrue(operationIds.contains(expected), "/v3/api-docs has no operation " + expected
                    + "; is the context missing a controller? Operations: " + operationIds);
        }
        assertTrue(broken.isEmpty(), "These 2xx responses are documented without a named type. Return a named "
                + "record rather than Map<String,Object> (or add an entry with a reason to ALLOWED):\n  "
                + String.join("\n  ", broken));
        for (String key : ALLOWED.keySet()) {
            assertTrue(untyped.contains(key), "ALLOWED lists " + key + ", which is now typed (or gone): remove the entry");
        }
    }

    /** Why an operation-level response schema isn't a named type, or null if it is fine. */
    static String problem(JsonNode schema) {
        if (schema.isMissingNode()) return "no schema";
        if (schema.has("$ref") || schema.has("oneOf") || schema.has("anyOf") || schema.has("allOf")) return null;
        if (schema.has("additionalProperties")) return "a free-form map (inline additionalProperties, no $ref)";
        String type = schema.path("type").asText("");
        if (type.equals("array")) {
            String items = problem(schema.path("items"));
            return items == null ? null : "an array of " + items;
        }
        if ((type.isEmpty() || type.equals("object")) && !schema.has("properties")) {
            return "an untyped inline object (no $ref, no properties)";
        }
        return null;
    }
}
