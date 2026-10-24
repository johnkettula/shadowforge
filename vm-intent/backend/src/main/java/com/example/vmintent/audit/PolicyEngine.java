package com.example.vmintent.audit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Decisions about catalog runs and definitions that need more than the caller's role: may this
 * person resume this run, approve this step, publish this definition? The built-in rules answer
 * first. If an OPA server is set (vmintent.policy.opa-url, e.g.
 * http://opa:8181/v1/data/vmintent/allow), it is asked too and both must allow.
 *
 * OPA gets  {"input": {"action", "actor", "roles", "resource", "attributes"}}  and must answer
 * {"result": true|false}  or  {"result": {"allow": true|false, "reason": "..."}}.
 * If OPA can't be reached the answer is no: a policy that can't be checked doesn't allow anything.
 *
 * Every decision is written to the decision log by the caller (see CatalogController).
 */
@Component
public class PolicyEngine {

    private static final Logger log = LoggerFactory.getLogger(PolicyEngine.class);

    public record Verdict(boolean allowed, String policy, String reason) {}

    private final String opaUrl;
    private final HttpClient http;
    private final ObjectMapper json = new ObjectMapper();

    public PolicyEngine(@Value("${vmintent.policy.opa-url:}") String opaUrl) {
        this.opaUrl = opaUrl == null || opaUrl.isBlank() ? null : opaUrl.trim();
        this.http = this.opaUrl == null ? null : HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
        if (this.opaUrl != null) log.info("Policy: built-in rules, then OPA at {}", this.opaUrl);
    }

    public boolean opaEnabled() {
        return opaUrl != null;
    }

    /**
     * builtIn = the built-in rule's answer (worked out by the caller, who knows the run).
     * Returns the final answer, with OPA's say when it's set up.
     */
    public Verdict decide(String action, String actor, List<String> roles, String resource,
                          Map<String, Object> attributes, Verdict builtIn) {
        if (!builtIn.allowed() || opaUrl == null) return builtIn;
        try {
            Map<String, Object> input = new LinkedHashMap<>();
            input.put("action", action);
            input.put("actor", actor);
            input.put("roles", roles);
            input.put("resource", resource);
            input.put("attributes", attributes == null ? Map.of() : attributes);
            HttpRequest req = HttpRequest.newBuilder(URI.create(opaUrl))
                    .timeout(Duration.ofSeconds(5))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("input", input))))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) {
                return new Verdict(false, builtIn.policy() + " + opa", "OPA answered HTTP " + res.statusCode() + ", so no");
            }
            JsonNode result = json.readTree(res.body()).path("result");
            boolean allow;
            String reason = null;
            if (result.isBoolean()) {
                allow = result.asBoolean();
            } else if (result.isObject()) {
                allow = result.path("allow").asBoolean(false);
                reason = result.path("reason").isTextual() ? result.path("reason").asText() : null;
            } else {
                return new Verdict(false, builtIn.policy() + " + opa", "OPA has no decision for " + action + " (result is undefined), so no");
            }
            return new Verdict(allow, builtIn.policy() + " + opa",
                    reason != null ? reason : allow ? builtIn.reason() : "refused by OPA policy");
        } catch (Exception e) {
            return new Verdict(false, builtIn.policy() + " + opa", "OPA couldn't be asked (" + e.getMessage() + "), so no");
        }
    }
}
