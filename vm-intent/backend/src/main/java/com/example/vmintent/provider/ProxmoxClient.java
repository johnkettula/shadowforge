package com.example.vmintent.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.failure.ApplicationFailure;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * A small HTTP client for the Proxmox VE API (/api2/json), authenticated with an API token.
 * Errors become Temporal failures the same way the vSphere client does it:
 *   429, 502, 503, 504, connection errors -> "CloudBusy" (retried with backoff);
 *   404                                   -> "NotFound" (not retried; callers decide);
 *   other 4xx                             -> "InvalidSpec" (not retried);
 *   other 5xx                             -> "CloudError" (retried).
 */
final class ProxmoxClient {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String base;
    private final String auth;
    private final HttpClient http;
    private final Duration timeout = Duration.ofSeconds(30);

    /** @param apiToken the token in Proxmox form: user@realm!tokenid=secret */
    ProxmoxClient(String baseUrl, String apiToken) {
        this.base = baseUrl.replaceAll("/+$", "") + "/api2/json";
        this.auth = "PVEAPIToken=" + apiToken;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** The "data" part of a GET response. */
    JsonNode get(String path) {
        return call("GET", path, null);
    }

    /** The "data" part of a POST response (for a task, this is the task ID). */
    JsonNode post(String path, Map<String, String> form) {
        return call("POST", path, form);
    }

    JsonNode delete(String path) {
        return call("DELETE", path, null);
    }

    private JsonNode call(String method, String path, Map<String, String> form) {
        HttpRequest.BodyPublisher body = form == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(encode(form));
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
                .timeout(timeout)
                .header("Authorization", auth)
                .method(method, body);
        if (form != null) {
            b.header("Content-Type", "application/x-www-form-urlencoded");
        }
        HttpResponse<String> r;
        try {
            r = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Proxmox is unreachable: " + e.getMessage(), "CloudBusy");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApplicationFailure.newFailure("Proxmox call interrupted", "CloudBusy");
        }
        int s = r.statusCode();
        if (s == 404) {
            throw ApplicationFailure.newNonRetryableFailure("Proxmox: not found: " + path, "NotFound");
        }
        if (s >= 400 && s < 500 && s != 429) {
            throw ApplicationFailure.newNonRetryableFailure("Proxmox " + s + ": " + r.body(), "InvalidSpec");
        }
        if (s >= 300) {
            String type = (s == 429 || s == 502 || s == 503 || s == 504) ? "CloudBusy" : "CloudError";
            throw ApplicationFailure.newFailure("Proxmox " + s + ": " + r.body(), type);
        }
        try {
            return JSON.readTree(r.body()).path("data");
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Proxmox sent a response that isn't JSON", "CloudError");
        }
    }

    private static String encode(Map<String, String> form) {
        return form.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "="
                        + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
    }
}
