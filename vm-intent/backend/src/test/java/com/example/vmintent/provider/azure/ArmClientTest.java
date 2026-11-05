package com.example.vmintent.provider.azure;

import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ArmClientTest {

    static final ArmClient.Tuning FAST = new ArmClient.Tuning(4, Duration.ofMillis(10), Duration.ofMillis(10), Duration.ofSeconds(10));
    static final String VMS = "Microsoft.Compute/virtualMachines";

    private MockArm arm;
    private final AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-11-04T10:00:00Z"));
    private ArmClient client;

    @BeforeEach
    void setUp() throws Exception {
        arm = new MockArm();
        client = new ArmClient(arm.properties(), FAST, now::get);
    }

    @AfterEach
    void tearDown() {
        arm.close();
    }

    private String vmPath(String name) {
        return client.resourcePath("Microsoft.Compute", "virtualMachines", name);
    }

    private static Map<String, Object> vm(Map<String, String> tags) {
        return Map.of("location", "westeurope", "tags", tags, "properties", Map.of("hardwareProfile", Map.of("vmSize", "Standard_B2s")));
    }

    private List<String> armCalls() {
        return arm.calls.stream().filter(c -> !c.contains("/oauth2/")).toList();
    }

    @Test
    void fetchesATokenFirstAndReusesItAcrossCalls() {
        assertThrows(ApplicationFailure.class, () -> client.get(vmPath("vm-a")));
        assertTrue(arm.calls.get(0).startsWith("POST /" + MockArm.TENANT + "/oauth2/v2.0/token"), arm.calls.toString());
        assertEquals(Map.of("grant_type", "client_credentials", "client_id", MockArm.CLIENT_ID, "client_secret", MockArm.CLIENT_SECRET,
                "scope", "https://management.azure.com/.default"), arm.tokenRequests.get(0));

        client.put(vmPath("vm-a"), vm(Map.of()));
        client.get(vmPath("vm-a"));
        now.set(now.get().plus(Duration.ofMinutes(50)));   // 59m59s lifetime: still more than 5 minutes left
        client.delete(vmPath("vm-a"));
        assertEquals(1, arm.tokenRequests.size(), "one token for every call");
    }

    @Test
    void renewsATokenWithLessThanFiveMinutesLeft() {
        client.put(vmPath("vm-a"), vm(Map.of()));
        now.set(now.get().plus(Duration.ofMinutes(55)));   // 4m59s left
        client.get(vmPath("vm-a"));
        assertEquals(2, arm.tokenRequests.size(), "a new token before the next call");
        String last = arm.calls.get(arm.calls.size() - 2);
        assertTrue(last.contains("/oauth2/v2.0/token"), "renewed before the call, not after a 401: " + arm.calls);
    }

    @Test
    void putIsPolledThroughAzureAsyncOperationUntilSucceeded() {
        arm.pollsUntilDone = 2;
        JsonNode res = client.put(vmPath("vm-a"), vm(Map.of("managed-by", "vm-intent", "env", "test")));
        assertEquals("Succeeded", res.path("properties").path("provisioningState").asText());
        long polls = armCalls().stream().filter(c -> c.startsWith("GET ") && c.contains("/operations/")).count();
        assertEquals(3, polls, "InProgress, InProgress, Succeeded: " + armCalls());
        assertTrue(armCalls().get(0).startsWith("PUT ") && armCalls().get(0).contains("api-version=2024-07-01"), armCalls().toString());

        JsonNode back = client.get(vmPath("vm-a"));
        assertEquals("Succeeded", back.path("properties").path("provisioningState").asText());
        assertEquals("vm-intent", back.path("tags").path("managed-by").asText());
        assertEquals("test", back.path("tags").path("env").asText());
        assertEquals("Standard_B2s", back.path("properties").path("hardwareProfile").path("vmSize").asText());

        client.delete(vmPath("vm-a"));   // waits until it's gone
        assertNull(arm.resource(VMS, "vm-a"));
        client.delete(vmPath("vm-a"));   // already gone: 204, fine
    }

    @Test
    void aFailedOperationIsNotRetryableAndCarriesArmsMessage() {
        arm.failNextOperation("Allocation failed. We do not have sufficient capacity for the requested VM size.");
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> client.put(vmPath("vm-a"), vm(Map.of())));
        assertTrue(f.isNonRetryable());
        assertTrue(f.getOriginalMessage().contains("sufficient capacity"), f.getOriginalMessage());
        assertEquals("Failed", arm.resource(VMS, "vm-a").path("properties").path("provisioningState").asText());
    }

    @Test
    void retries429And500ThenSucceedsHonouringRetryAfter() {
        client.put(vmPath("vm-a"), vm(Map.of()));
        arm.failNext(2, 429);
        assertEquals("vm-a", client.get(vmPath("vm-a")).path("name").asText());
        arm.failNext(3, 500);
        assertEquals("vm-a", client.get(vmPath("vm-a")).path("name").asText());

        arm.retryAfter = "1";
        arm.failNext(1, 429);
        long start = System.nanoTime();
        client.get(vmPath("vm-a"));
        assertTrue(System.nanoTime() - start >= 900_000_000L, "waited the second Retry-After asked for");
    }

    @Test
    void givesUpAfterTheLastAttemptWithARetryableFailure() {
        arm.failNext(10, 503);
        ApplicationFailure busy = assertThrows(ApplicationFailure.class, () -> client.get(vmPath("vm-a")));
        assertEquals("CloudBusy", busy.getType());
        assertFalse(busy.isNonRetryable());
        assertEquals(FAST.maxAttempts(), armCalls().size());

        arm.failNext(10, 500);
        ApplicationFailure error = assertThrows(ApplicationFailure.class, () -> client.get(vmPath("vm-a")));
        assertEquals("CloudError", error.getType());
        assertFalse(error.isNonRetryable());
    }

    @Test
    void a400IsSentOnceAndIsInvalidSpec() {
        ApplicationFailure f = assertThrows(ApplicationFailure.class,
                () -> client.put(vmPath("vm-a"), Map.of("properties", Map.of())));   // no location
        assertEquals("InvalidSpec", f.getType());
        assertTrue(f.isNonRetryable());
        assertTrue(f.getOriginalMessage().contains("LocationRequired"), f.getOriginalMessage());
        assertEquals(1, armCalls().size(), armCalls().toString());
    }

    @Test
    void a404IsNotFound() {
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> client.get(vmPath("nope")));
        assertEquals("NotFound", f.getType());
        assertTrue(f.isNonRetryable());
        assertEquals(1, armCalls().size());
    }

    @Test
    void aWrongSecretIsCloudAuthAndArmRefusesCallsWithoutAToken() throws Exception {
        AzureProperties p = arm.properties();
        AzureProperties wrong = new AzureProperties(p.tenantId(), p.clientId(), "wrong", p.subscriptionId(), p.resourceGroup(),
                p.location(), p.loginUrl(), p.managementUrl(), p.timeoutSeconds());
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> new ArmClient(wrong, FAST, now::get).get(vmPath("vm-a")));
        assertEquals("CloudAuth", f.getType());
        assertTrue(f.isNonRetryable());
        assertEquals(1, arm.tokenRequests.size(), "sent once");
        assertTrue(armCalls().isEmpty());

        HttpResponse<String> noToken = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create(arm.url() + vmPath("vm-a") + "?api-version=2024-07-01")).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(401, noToken.statusCode());
    }

    @Test
    void propertiesKeepTheSecretOutOfToStringAndNeedEverythingToBeConfigured() {
        AzureProperties p = arm.properties();
        assertFalse(p.toString().contains(MockArm.CLIENT_SECRET), p.toString());
        assertTrue(p.configured());
        AzureProperties empty = new AzureProperties("t", "c", "", "s", "rg", null, null, null, null);
        assertFalse(empty.configured());
        assertEquals(AzureProperties.LOGIN_URL, empty.loginUrl());
        assertEquals(AzureProperties.MANAGEMENT_URL, empty.managementUrl());
    }
}
