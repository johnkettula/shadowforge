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
import java.util.ArrayList;
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

    // ------------------------------------------------------------------ non-blocking path (for activities)

    private long operationPolls() {
        return armCalls().stream().filter(c -> c.startsWith("GET ") && c.contains("/operations/")).count();
    }

    @Test
    void beginReturnsWhileTheOperationIsStillInProgressWithoutPolling() {
        arm.pollsUntilDone = 3;
        ArmClient.Started s = client.begin("PUT", vmPath("vm-a"), vm(Map.of("managed-by", "vm-intent")));
        assertEquals(201, s.status());
        assertEquals("vm-a", s.body().path("name").asText());
        assertEquals("Creating", s.body().path("properties").path("provisioningState").asText());
        assertTrue(s.operationUrl().startsWith(arm.url() + "/subscriptions/") && s.operationUrl().contains("/operations/"), s.operationUrl());
        assertEquals(0, operationPolls(), "no operation-status GET: " + armCalls());
        assertEquals(1, armCalls().size(), armCalls().toString());
        assertEquals(List.of("InProgress"), arm.operations.values().stream().map(o -> o.status).toList());
    }

    @Test
    void operationIsReadOnceAtATimeUntilSucceeded() {
        arm.pollsUntilDone = 2;
        String op = client.begin("PUT", vmPath("vm-a"), vm(Map.of())).operationUrl();
        List<ArmClient.OperationStatus> seen = new ArrayList<>();
        ArmClient.Operation o;
        do {
            o = client.operation(op);
            seen.add(o.status());
            assertEquals(seen.size(), operationPolls(), "one GET per operation() call");
        } while (!o.done() && seen.size() < 10);
        assertEquals(List.of(ArmClient.OperationStatus.InProgress, ArmClient.OperationStatus.InProgress, ArmClient.OperationStatus.Succeeded), seen);
        assertNull(o.errorCode());
        assertEquals("Succeeded", client.get(vmPath("vm-a")).path("properties").path("provisioningState").asText());

        ArmClient.Started del = client.begin("DELETE", vmPath("vm-a"), null);
        assertEquals(202, del.status());
        assertEquals(ArmClient.OperationStatus.InProgress, client.operation(del.operationUrl()).status());
        assertEquals(ArmClient.OperationStatus.InProgress, client.operation(del.operationUrl()).status());
        assertEquals(ArmClient.OperationStatus.Succeeded, client.operation(del.operationUrl()).status());
        assertNull(arm.resource(VMS, "vm-a"));
        assertNull(client.begin("DELETE", vmPath("vm-a"), null).operationUrl(), "already gone: 204, nothing to follow");
    }

    @Test
    void aFailedOperationIsReturnedWithArmsCodeAndMessageNotThrown() {
        arm.failNextOperation("Allocation failed. We do not have sufficient capacity for the requested VM size.");
        String op = client.begin("PUT", vmPath("vm-a"), vm(Map.of())).operationUrl();
        assertEquals(ArmClient.OperationStatus.InProgress, client.operation(op).status());
        ArmClient.Operation o = client.operation(op);
        assertEquals(ArmClient.OperationStatus.Failed, o.status());
        assertTrue(o.done());
        assertEquals("OperationFailed", o.errorCode());
        assertTrue(o.errorMessage().contains("sufficient capacity"), o.errorMessage());
    }

    @Test
    void operationRefusesAnAddressOutsideTheManagementUrlAndSendsNothingThere() throws Exception {
        try (MockArm other = new MockArm()) {
            String path = "/subscriptions/" + MockArm.SUBSCRIPTION + "/providers/Microsoft.Compute/locations/westeurope/operations/op-1?api-version=2024-07-01";
            for (String url : List.of(other.url() + path, arm.url() + "0" + path, "https://example.com" + path)) {
                ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> client.operation(url), url);
                assertEquals("CloudError", f.getType());
                assertTrue(f.isNonRetryable());
            }
            assertTrue(other.calls.isEmpty(), other.calls.toString());
            assertTrue(arm.calls.isEmpty(), "not even a sign-in: " + arm.calls);
        }
    }

    @Test
    void aRetryAfterLongerThanTheBudgetIsCloudBusyAtOnce() {
        ArmClient fresh = new ArmClient(arm.properties());   // the default tuning, sign-in included
        arm.retryAfter = "120";
        arm.failNext(10, 429);
        long start = System.nanoTime();
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> fresh.get(vmPath("vm-a")));
        Duration took = Duration.ofNanos(System.nanoTime() - start);
        assertEquals("CloudBusy", f.getType());
        assertFalse(f.isNonRetryable());
        assertEquals(Duration.ofSeconds(60), f.getNextRetryDelay(), "Temporal waits, up to a minute");
        assertEquals(1, armCalls().size(), "no second try inside the call: " + armCalls());
        assertTrue(took.compareTo(Duration.ofSeconds(15)) < 0, "took " + took);
        assertTrue(took.compareTo(Duration.ofSeconds(5)) < 0, "did not sleep: took " + took);

        arm.failNext(0, 429);
        ArmClient.Started started = fresh.begin("PUT", vmPath("vm-a"), vm(Map.of()));
        arm.failNext(10, 429);
        ApplicationFailure op = assertThrows(ApplicationFailure.class, () -> fresh.operation(started.operationUrl()));
        assertEquals("CloudBusy", op.getType());
        assertFalse(op.isNonRetryable());
    }

    @Test
    void anAnswerHeldPastTheRequestTimeoutIsCloudBusyWithinTheBudget() {
        AzureProperties p = arm.properties();
        AzureProperties slowDefault = new AzureProperties(p.tenantId(), p.clientId(), p.clientSecret(), p.subscriptionId(),
                p.resourceGroup(), p.location(), p.loginUrl(), p.managementUrl(), null);   // timeoutSeconds: the default 30
        ArmClient fresh = new ArmClient(slowDefault);
        arm.responseDelay = Duration.ofSeconds(60);
        long start = System.nanoTime();
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> fresh.begin("PUT", vmPath("vm-a"), vm(Map.of())));
        Duration took = Duration.ofNanos(System.nanoTime() - start);
        assertEquals("CloudBusy", f.getType());
        assertFalse(f.isNonRetryable());
        assertTrue(took.compareTo(Duration.ofSeconds(15)) < 0, "took " + took);
        assertTrue(took.compareTo(ArmClient.Tuning.CALL_BUDGET.plusSeconds(1)) < 0, "kept to the budget: took " + took);
    }

    @Test
    void a409IsCloudBusyRetryableAndSentOnce() {
        arm.failNext(1, 409);
        ApplicationFailure f = assertThrows(ApplicationFailure.class, () -> client.begin("PUT", vmPath("vm-a"), vm(Map.of())));
        assertEquals("CloudBusy", f.getType());
        assertFalse(f.isNonRetryable());
        assertEquals(1, armCalls().size(), "Temporal retries it, not the client: " + armCalls());
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
