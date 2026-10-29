package com.example.vmintent.provider.vsphere;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import io.temporal.failure.ApplicationFailure;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The HTTP + JSON plumbing shared by the vCenter and VCF Automation clients.
 *
 * Errors become Temporal failures the build workflow already knows how to treat:
 *   429, 503, 502, 504, connection errors -> "CloudBusy", retried with backoff (like a throttled cloud);
 *   404                                   -> "NotFound" (callers decide whether that's fine);
 *   other 4xx                             -> "InvalidSpec", not retried (the request itself is wrong);
 *   other 5xx                             -> "CloudError", retried.
 */
final class HttpJson {

    static final ObjectMapper JSON = new ObjectMapper();

    private final String base;
    private final HttpClient http;
    private final Duration timeout;
    private final String what;

    HttpJson(String what, String baseUrl, String caFile, int timeoutSeconds) {
        this.what = what;
        this.base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        this.timeout = Duration.ofSeconds(timeoutSeconds);
        HttpClient.Builder b = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER);
        if (caFile != null && !caFile.isBlank()) b.sslContext(sslContextFor(Path.of(caFile)));
        this.http = b.build();
    }

    record Response(int status, JsonNode body, Map<String, String> headers) {}

    Response send(String method, String path, Object body, Map<String, String> headers) {
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(base + path)).timeout(timeout);
        headers.forEach(rb::header);
        rb.header("Accept", "application/json");
        HttpRequest.BodyPublisher pub;
        if (body == null) {
            pub = HttpRequest.BodyPublishers.noBody();
        } else if (body instanceof Form f) {
            rb.header("Content-Type", "application/x-www-form-urlencoded");
            pub = HttpRequest.BodyPublishers.ofString(f.encoded());
        } else {
            rb.header("Content-Type", "application/json");
            try {
                pub = HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body));
            } catch (IOException e) {
                throw new IllegalArgumentException(e);
            }
        }
        rb.method(method, pub);
        HttpResponse<String> res;
        try {
            res = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw ApplicationFailure.newFailure(what + " is unreachable (" + method + " " + path + "): " + e.getMessage(), "CloudBusy");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw ApplicationFailure.newFailure(what + " call interrupted", "CloudBusy");
        }
        JsonNode json;
        try {
            json = res.body() == null || res.body().isBlank() ? NullNode.getInstance() : JSON.readTree(res.body());
        } catch (IOException e) {
            json = JSON.getNodeFactory().textNode(res.body());
        }
        Map<String, String> h = res.headers().map().entrySet().stream()
                .collect(Collectors.toMap(e -> e.getKey().toLowerCase(), e -> e.getValue().isEmpty() ? "" : e.getValue().get(0), (a, c) -> a));
        return new Response(res.statusCode(), json, h);
    }

    /** Throws the matching failure for an error status; returns the response otherwise. */
    Response check(Response r, String method, String path) {
        int s = r.status();
        if (s < 300) return r;
        String msg = what + " answered " + s + " to " + method + " " + path + ": " + errorText(r.body());
        if (s == 429 || s == 502 || s == 503 || s == 504) throw ApplicationFailure.newFailure(msg, "CloudBusy");
        if (s == 404) throw ApplicationFailure.newNonRetryableFailure(msg, "NotFound");
        if (s == 401 || s == 403) throw ApplicationFailure.newNonRetryableFailure(msg + " (check the account and its permissions)", "CloudAuth");
        if (s >= 400 && s < 500) throw ApplicationFailure.newNonRetryableFailure(msg, "InvalidSpec");
        throw ApplicationFailure.newFailure(msg, "CloudError");
    }

    /** The error message vCenter or VCF Automation put in the body, as short as possible. */
    static String errorText(JsonNode body) {
        if (body == null || body.isNull()) return "(no details)";
        for (String f : new String[]{"message", "error_message", "failureMessage", "error_type", "error"}) {
            JsonNode v = body.get(f);
            if (v != null && v.isTextual()) return v.asText();
        }
        JsonNode messages = body.get("messages");
        if (messages != null && messages.isArray() && !messages.isEmpty()) {
            JsonNode m = messages.get(0);
            if (m.has("default_message")) return m.get("default_message").asText();
        }
        String text = body.toString();
        return text.length() > 400 ? text.substring(0, 400) + "..." : text;
    }

    static String q(String v) {
        return URLEncoder.encode(v == null ? "" : v, StandardCharsets.UTF_8);
    }

    /** A form body (application/x-www-form-urlencoded). */
    record Form(Map<String, String> fields) {
        String encoded() {
            return fields.entrySet().stream().map(e -> q(e.getKey()) + "=" + q(e.getValue())).collect(Collectors.joining("&"));
        }
    }

    /** Trusts the certificates in a PEM file (in addition to nothing else): for vCenter's own CA. */
    static SSLContext sslContextFor(Path pem) {
        try (InputStream in = Files.newInputStream(pem)) {
            KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
            ks.load(null, null);
            int i = 0;
            for (Certificate c : CertificateFactory.getInstance("X.509").generateCertificates(in)) ks.setCertificateEntry("ca-" + i++, c);
            if (i == 0) throw new IllegalStateException("no certificates in " + pem);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(ks);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tmf.getTrustManagers(), null);
            return ctx;
        } catch (Exception e) {
            throw new IllegalStateException("Can't read the CA file " + pem + ": " + e.getMessage(), e);
        }
    }
}
