package com.example.vmintent.api;

import com.example.vmintent.catalog.ClassificationCatalog;
import com.example.vmintent.config.OpenApiConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.swagger.v3.core.converter.ModelConverters;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.Paths;
import io.swagger.v3.oas.models.media.Schema;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class CatalogControllerTest {

    private static CatalogController withClassifications() {
        ClassificationCatalog c = ClassificationCatalog.of(Map.of("default", "C3", "classifications", List.of(
                Map.of("code", "C1", "label", "Internal", "retentionYears", 1),
                Map.of("code", "C3", "label", "Confidential", "retentionYears", 3))), null);
        return new CatalogController(null, c, null, null, null, null, null);
    }

    @Test
    void classificationsKeepTheirJsonShape() throws Exception {
        String json = new ObjectMapper().writeValueAsString(withClassifications().classifications());
        assertEquals("{\"default\":\"C3\",\"classifications\":[{\"code\":\"C1\",\"label\":\"Internal\",\"retentionYears\":1},"
                + "{\"code\":\"C3\",\"label\":\"Confidential\",\"retentionYears\":3}]}", json);
    }

    @Test
    void classificationsSchemaIsNamedWithADefaultCode() {
        Map<String, Schema> schemas = ModelConverters.getInstance().readAll(CatalogController.ClassificationsResponse.class);
        Schema<?> response = schemas.get("ClassificationsResponse");
        assertEquals(List.of("default", "classifications"), List.copyOf(response.getProperties().keySet()));
        assertEquals("string", response.getProperties().get("default").getType());
        assertEquals("#/components/schemas/Classification", response.getProperties().get("classifications").getItems().get$ref());
        assertEquals(List.of("code", "label", "retentionYears"), List.copyOf(schemas.get("Classification").getProperties().keySet()));
    }

    @Test
    void javaObjectValuesAreDocumentedAsAnyJsonValue() {
        // StepDef.with is Map<String, Object> and InputDef.defaultValue is Object: strings, numbers and lists are fine.
        OpenAPI api = new OpenAPI().paths(new Paths()).components(new Components()
                .schemas(Map.copyOf(ModelConverters.getInstance().readAll(com.example.vmintent.catalog.CatalogModels.Definition.class))));
        new OpenApiConfig().contractFixes().customise(api);
        Schema<?> step = api.getComponents().getSchemas().get("StepDef");
        Schema<?> with = step.getProperties().get("with");
        assertEquals("object", with.getType());
        assertNull(((Schema<?>) with.getAdditionalProperties()).getType());
        Schema<?> input = api.getComponents().getSchemas().get("InputDef");
        assertNull(input.getProperties().get("defaultValue").getType());
        assertNull(input.getProperties().get("allowed").getItems().getType());
        assertEquals("string", input.getProperties().get("name").getType());
    }
}
