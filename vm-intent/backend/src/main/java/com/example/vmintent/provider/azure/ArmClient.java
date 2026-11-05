package com.example.vmintent.provider.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import io.temporal.failure.ApplicationFailure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Azure Resource Manager over plain HTTPS + JSON (see docs/AZURE.md): a client-credentials token renewed when less
 * than 5 minutes of it are left; put / get / delete with ?api-version=; PUT and DELETE that name an
 * Azure-AsyncOperation (or 202 + Location) are polled until done, and Failed or Canceled is a non-retryable "CloudError".
 *
 * Errors become the Temporal failures the build workflow already knows how to treat:
 *   429, 502, 503, 504, connection errors -> retried here with backoff (Retry-After honoured), then "CloudBusy" (retryable)
 *   other 5xx                             -> retried here with backoff, then "CloudError" (retryable)
 *   401, 403                              -> "CloudAuth", 404 -> "NotFound", other 4xx -> "InvalidSpec": sent once, not retryable
 */
public class ArmClient {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String SCOPE = "https://management.azure.com/.default";
    static final Duration RENEW_BEFORE = Duration.ofMinutes(5);
    static final Duration MAX_WAIT = Duration.ofSeconds(60);
    private static final Logger log = LoggerFactory.getLogger(ArmClient.class);

    /** The api-version used for each resource provider when the caller doesn't give one. */
    static final Map<String, String> API_VERSIONS = Map.of(
            "Microsoft.Compute", "2024-07-01",
            "Microsoft.Network", "2024-05-01");
    static final String DEFAULT_API_VERSION = "2021-04-01";

    /** How hard to try: attempts per call (429/5xx), the first backoff (doubled each time), and polling. */
    public record Tuning(int maxAttempts, Duration backoff, Duration pollInterval, Duration pollTimeout) {
        public static final Tuning DEFAULT = new Tuning(4, Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofMinutes(30));
    }

    public record Response(int status, JsonNode body, Map<String, String> headers) {
        String header(String name) {
            return headers.get(name.toLowerCase());
        }
    }

    private final AzureProperties cfg;
    private final Tuning tuning;
    private final Supplier<Instant> clock;
    private final HttpClient http;
    private String token;
    private Instant tokenExpiresAt = Instant.MIN;

    public ArmClient(AzureProperties cfg) {
        this(cfg, Tuning.DEFAULT, Instant::now);
    }

    ArmClient(AzureProperties cfg, Tuning tuning, Supplier<Instant> clock) {
        this.cfg = cfg;
        this.tuning = tuning;
        this.clock = clock;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    /** /subscriptions/{sub}/resourceGroups/{rg}/providers/{provider}/{type}/{name}, e.g. ("Microsoft.Compute", "virtualMachines", "vm1"). */
    public String resourcePath(String provider, String type, String name) {
        return "/subscriptions/" + enc(cfg.subscriptionId()) + "/resourceGroups/" + enc(cfg.resourceGroup())
                + "/providers/" + provider + "/" + type + "/" + enc(name);
    }

    // ------------------------------------------------------------------ calls

    // A path may carry its own ?api-version=...; otherwise the one for its resource provider is added.

    /** Creates or updates a resource and waits for it to finish; returns the resource as ARM then describes it. */
    public JsonNode put(String path, Object body) {
        Response r = send("PUT", url(path), body);
        return awaitIfAsync(r, "PUT", path) ? send("GET", url(path), null).body() : r.body();
    }

    public JsonNode get(String path) {
        return send("GET", url(path), null).body();
    }

    /** Deletes a resource and waits for it to be gone. */
    public void delete(String path) {
        awaitIfAsync(send("DELETE", url(path), null), "DELETE", path);
    }

    static String apiVersionFor(String path) {
        int i = path.lastIndexOf("/providers/");
        if (i < 0) return DEFAULT_API_VERSION;
        String provider = path.substring(i + "/providers/".length()).split("/")[0];
        return API_VERSIONS.getOrDefault(provider, DEFAULT_API_VERSION);
    }

    private String url(String path) {
        if (path.contains("api-version=")) return cfg.managementUrl() + path;
        return cfg.managementUrl() + path + (path.contains("?") ? "&" : "?") + "api-version=" + enc(apiVersionFor(path));
    }

    // ------------------------------------------------------------------ long-running operations

    /**
     * Waits for the operation an answer names: Azure-AsyncOperation (with 200, 201 or 202; ARM updates answer 200)
     * or Location (with 202). False when there was nothing to wait for.
     */
    private boolean awaitIfAsync(Response first, String method, String path) {
        String async = first.status() < 300 ? first.header("Azure-AsyncOperation") : null;
        String location = first.status() == 202 ? first.header("Location") : null;
        if (async == null && location == null) return false;
        String pollUrl = async != null ? async : location;
        if (!pollUrl.startsWith(cfg.managementUrl() + "/")) {
            // The token goes with every poll: never send it anywhere but ARM.
            throw ApplicationFailure.newNonRetryableFailure("ARM asked to poll " + method + " " + path
                    + " at an address outside " + cfg.managementUrl(), "CloudError");
        }
        Instant deadline = clock.get().plus(tuning.pollTimeout());
        Response last = first;
        while (true) {
            if (clock.get().isAfter(deadline)) {
                throw ApplicationFailure.newFailure("ARM " + method + " " + path + " still running after "
                        + tuning.pollTimeout().toMinutes() + " minutes", "CloudBusy");
            }
            sleep(waitFor(last, tuning.pollInterval()));
            last = send("GET", pollUrl, null);
            if (async != null) {
                String status = last.body().path("status").asText("");
                if ("Succeeded".equalsIgnoreCase(status)) return true;
                if ("Failed".equalsIgnoreCase(status) || "Canceled".equalsIgnoreCase(status)) {
                    throw ApplicationFailure.newNonRetryableFailure("ARM " + method + " " + path + " " + status.toLowerCase()
                            + ": " + errorText(last.body()), "CloudError");
                }
            } else if (last.status() != 202) {
                return true;
            }
        }
    }

    // ------------------------------------------------------------------ sign-in

    private synchronized String bearer() {
        if (token != null && clock.get().isBefore(tokenExpiresAt.minus(RENEW_BEFORE))) return token;
        String url = cfg.loginUrl() + "/" + enc(cfg.tenantId()) + "/oauth2/v2.0/token";
        String form = "grant_type=client_credentials&client_id=" + enc(cfg.clientId()) + "&client_secret=" + enc(cfg.clientSecret())
                + "&scope=" + enc(SCOPE);
        JsonNode r = execute("POST", url, HttpRequest.BodyPublishers.ofString(form), "application/x-www-form-urlencoded", true).body();
        String t = r.path("access_token").asText("");
        if (t.isBlank()) throw ApplicationFailure.newNonRetryableFailure("Azure sign-in returned no access token", "CloudAuth");
        token = t;
        tokenExpiresAt = clock.get().plusSeconds(r.path("expires_in").asLong(3600));
        log.info("Azure: signed in to tenant {} as {}", cfg.tenantId(), cfg.clientId());
        return token;
    }

    // ------------------------------------------------------------------ HTTP

    Response send(String method, String url, Object body) {
        HttpRequest.BodyPublisher pub;
        try {
            pub = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body));
        } catch (IOException e) {
            throw new IllegalArgumentException(e);
        }
        return execute(method, url, pub, body == null ? null : "application/json", false);
    }

    /** One call, retried on 429/5xx and connection errors; with a bearer token unless it is the sign-in itself. */
    private Response execute(String method, String url, HttpRequest.BodyPublisher pub, String contentType, boolean login) {
        String what = login ? "Azure sign-in" : "ARM";
        String shown = method + " " + url.replaceFirst("\\?.*$", "");
        for (int attempt = 1; ; attempt++) {
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(cfg.timeoutSeconds()))
                    .header("Accept", "application/json").method(method, pub);
            if (contentType != null) rb.header("Content-Type", contentType);
            if (!login) rb.header("Authorization", "Bearer " + bearer());
            Response r;
            try {
                HttpResponse<String> res = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
                Map<String, String> h = new HashMap<>();
                res.headers().map().forEach((k, v) -> h.putIfAbsent(k.toLowerCase(), v.isEmpty() ? "" : v.get(0)));
                r = new Response(res.statusCode(), parse(res.body()), h);
            } catch (IOException e) {
                r = null;
                if (attempt >= tuning.maxAttempts()) {
                    throw ApplicationFailure.newFailure(what + " is unreachable (" + shown + "): " + e.getMessage(), "CloudBusy");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw ApplicationFailure.newFailure(what + " call interrupted", "CloudBusy");
            }
            int s = r == null ? 0 : r.status();
            if (r != null && s < 400) return r;
            boolean retry = r == null || s == 429 || s >= 500;
            if (retry && attempt < tuning.maxAttempts()) {
                Duration wait = waitFor(r, tuning.backoff().multipliedBy(1L << (attempt - 1)));
                log.info("Azure: {} answered {}; try {} of {} in {} ms", shown, s == 0 ? "nothing" : s, attempt + 1,
                        tuning.maxAttempts(), wait.toMillis());
                sleep(wait);
                continue;
            }
            String msg = what + " answered " + s + " to " + shown + ": " + errorText(r.body());
            if (s == 429 || s == 502 || s == 503 || s == 504) throw ApplicationFailure.newFailure(msg, "CloudBusy");
            if (s >= 500) throw ApplicationFailure.newFailure(msg, "CloudError");
            if (s == 401 || s == 403 || login) {
                throw ApplicationFailure.newNonRetryableFailure(msg + " (check the service principal and its role)", "CloudAuth");
            }
            if (s == 404) throw ApplicationFailure.newNonRetryableFailure(msg, "NotFound");
            throw ApplicationFailure.newNonRetryableFailure(msg, "InvalidSpec");
        }
    }

    /** Retry-After (seconds) when the answer has one, else the fallback; never more than a minute. */
    static Duration waitFor(Response r, Duration fallback) {
        String ra = r == null || r.header("Retry-After") == null ? "" : r.header("Retry-After").trim();
        Duration d = ra.matches("\\d{1,6}") ? Duration.ofSeconds(Long.parseLong(ra)) : fallback;   // an HTTP date: the fallback
        return d.compareTo(MAX_WAIT) > 0 ? MAX_WAIT : d;
    }

    private static void sleep(Duration d) {
        if (d.isZero() || d.isNegative()) return;
        try {
            Thread.sleep(d.toMillis());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApplicationFailure.newFailure("ARM call interrupted", "CloudBusy");
        }
    }

    private static JsonNode parse(String body) {
        if (body == null || body.isBlank()) return NullNode.getInstance();
        try {
            return JSON.readTree(body);
        } catch (IOException e) {
            return JSON.getNodeFactory().textNode(body);
        }
    }

    /** ARM's {"error": {"code", "message"}}, or the sign-in endpoint's error_description, as short as possible. */
    static String errorText(JsonNode body) {
        if (body == null || body.isNull()) return "(no details)";
        JsonNode e = body.path("error");
        if (e.isObject()) return e.path("code").asText("") + ": " + e.path("message").asText("");
        if (body.has("error_description")) return body.get("error_description").asText();
        String text = body.toString();
        return text.length() > 400 ? text.substring(0, 400) + "..." : text;
    }

    private static String enc(String v) {
        return URLEncoder.encode(v == null ? "" : v, StandardCharsets.UTF_8);
    }
}
