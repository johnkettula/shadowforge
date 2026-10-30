package com.example.vmintent.api;

import com.example.vmintent.provider.vsphere.VcfAutomationClient;
import com.example.vmintent.provider.vsphere.VsphereProperties;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.provider.vsphere.VsphereTestKit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VsphereControllerTest {

    private static VsphereController notSetUp() {
        return new VsphereController(new VsphereRoutes(new VsphereProperties(null, null, null, null), null, null));
    }

    @Test
    void eachFailureTypeMapsToOneStatus() {
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, VsphereController.statusFor(VsphereRoutes.NOT_SET_UP));
        assertEquals(HttpStatus.NOT_FOUND, VsphereController.statusFor("NotFound"));
        assertEquals(HttpStatus.BAD_GATEWAY, VsphereController.statusFor("CloudAuth"));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, VsphereController.statusFor("CloudBusy"));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, VsphereController.statusFor("InvalidSpec"));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, VsphereController.statusFor(null));
    }

    @Test
    void templatesWithoutVcenterIs503() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> notSetUp().templates());
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, e.getStatusCode());
        assertTrue(e.getReason().startsWith("vCenter isn't set up"), e.getReason());
    }

    @Test
    void blueprintsWithoutAutomationAre503() {
        for (Runnable call : List.<Runnable>of(() -> notSetUp().blueprints(), () -> notSetUp().blueprint("anything"))) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, e.getStatusCode());
            assertTrue(e.getReason().startsWith("VCF Automation isn't set up"), e.getReason());
        }
    }

    @Test
    void statusWithoutVsphereLeavesOutEmptyFields() throws Exception {
        String json = new ObjectMapper().writeValueAsString(notSetUp().status());
        assertEquals("{\"defaultRoute\":\"simulated\",\"datacenters\":{},\"vcenter\":{\"configured\":false},"
                + "\"automation\":{\"configured\":false}}", json);
    }

    @Test
    void withVsphereSetUpStatusSignsInAndAnUnknownBlueprintIs404() throws Exception {
        try (VsphereTestKit kit = new VsphereTestKit()) {
            VsphereController c = new VsphereController(kit.routes());
            VsphereController.VsphereStatusResponse s = c.status();
            assertEquals(Map.of("dc1", "vcenter", "dc2", "vcf-automation"), s.datacenters());
            assertEquals(Boolean.TRUE, s.vcenter().ok(), s.vcenter().detail());
            assertEquals(Boolean.TRUE, s.automation().ok(), s.automation().detail());
            assertEquals("bp-1", c.blueprint("vm-intent-standard").blueprint().id());
            ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> c.blueprint("no-such"));
            assertEquals(HttpStatus.NOT_FOUND, e.getStatusCode());
        }
    }

    @Test
    void blueprintSerializesWithTheSameThreeTopLevelKeys() throws Exception {
        ObjectMapper json = new ObjectMapper();
        try (VsphereTestKit kit = new VsphereTestKit()) {
            JsonNode body = json.valueToTree(new VsphereController(kit.routes()).blueprint("vm-intent-standard"));
            List<String> keys = new ArrayList<>();
            body.fieldNames().forEachRemaining(keys::add);
            assertEquals(List.of("blueprint", "releasedVersions", "inputs"), keys);
            assertEquals("bp-1", body.path("blueprint").path("id").asText());
            assertEquals("vm-intent-standard", body.path("blueprint").path("name").asText());
            assertTrue(body.path("releasedVersions").isArray(), body.toString());
            // The inputs schema has "properties", so inputs is that object, not the whole schema.
            assertEquals("integer", body.path("inputs").path("cpuCount").path("type").asText(), body.toString());
            assertFalse(body.path("inputs").has("properties"), body.toString());
        }
        // Without "properties", inputs is the whole schema; the record writes exactly what it was given.
        JsonNode schema = json.readTree("{\"type\":\"object\"}");
        String written = json.writeValueAsString(new VsphereController.VsphereBlueprintResponse(
                new VcfAutomationClient.Blueprint("bp-2", "plain", null, "RELEASED", "p-1"), List.of("1"), schema));
        assertEquals("{\"blueprint\":{\"id\":\"bp-2\",\"name\":\"plain\",\"description\":null,\"status\":\"RELEASED\","
                + "\"projectId\":\"p-1\"},\"releasedVersions\":[\"1\"],\"inputs\":{\"type\":\"object\"}}", written);
    }
}
