package com.example.vmintent.intent;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Asks an LLM to fill in the IntentDraft fields as JSON. The model only
 * reports what the user said; Vocabulary normalizes its values and
 * PolicyDefaults fills the gaps, exactly as for the rule-based path.
 * If the call fails for any reason, the rule-based extractor answers instead.
 */
public class LlmIntentExtractor implements IntentExtractor {

    private static final Logger log = LoggerFactory.getLogger(LlmIntentExtractor.class);

    private static final String SYSTEM_PROMPT = """
            You convert a request for a virtual machine into JSON. Reply with ONE JSON object and nothing else.
            Use null for anything the user did not state. Never guess or add defaults.
            Fields:
              name: string or null
              provider: "vsphere" | "aws" | "azure" | "gcp" | null  (on-prem / VMware = vsphere)
              region: "us-east" | "us-west" | "us-central" | "eu-west" | "dc1" | "dc2" | null
              vcpu: integer or null
              memoryGiB: integer or null
              sizeClass: "xsmall" | "small" | "medium" | "large" | "xlarge" | null
              os: "ubuntu" | "rhel" | "windows" | "debian" | "rocky" | "linux" | null
              osVersion: string or null
              diskGiB: integer or null
              diskTier: "ssd" | "standard" | null
              env: "dev" | "test" | "staging" | "prod" | null
              ttlDays: integer or null
              publicIp: true | false | null
            Examples:
              "Ubuntu box, 4 cores, 16 gigs, us-east on AWS" ->
              {"provider":"aws","region":"us-east","vcpu":4,"memoryGiB":16,"os":"ubuntu"}
              "I need a medium Linux server in Virginia on Amazon" ->
              {"provider":"aws","region":"us-east","sizeClass":"medium","os":"linux"}
            """;

    private final String apiKey;
    private final String model;
    private final String url;
    private final IntentExtractor fallback;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper json = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    public LlmIntentExtractor(String apiKey, String model, String url, IntentExtractor fallback) {
        this.apiKey = apiKey;
        this.model = model;
        this.url = url;
        this.fallback = fallback;
    }

    @Override
    public String name() {
        return "llm:" + model;
    }

    @Override
    public IntentDraft extract(String text) {
        try {
            ObjectNode body = json.createObjectNode();
            body.put("model", model);
            body.put("max_tokens", 400);
            body.put("temperature", 0);
            body.put("system", SYSTEM_PROMPT);
            ObjectNode msg = body.putArray("messages").addObject();
            msg.put("role", "user");
            msg.put("content", text);

            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(30))
                    .header("content-type", "application/json")
                    .header("x-api-key", apiKey)
                    .header("anthropic-version", "2023-06-01")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                    .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) throw new IllegalStateException("LLM HTTP " + resp.statusCode());

            JsonNode root = json.readTree(resp.body());
            String answer = root.path("content").path(0).path("text").asText();
            int start = answer.indexOf('{');
            int end = answer.lastIndexOf('}');
            IntentDraft d = json.readValue(answer.substring(start, end + 1), IntentDraft.class);

            // Normalize whatever the model wrote into our vocabulary.
            d.provider = Vocabulary.normalize(Vocabulary.PROVIDER_WORDS, d.provider);
            d.region = Vocabulary.normalize(Vocabulary.REGION_WORDS, d.region);
            d.os = Vocabulary.normalize(Vocabulary.OS_WORDS, d.os);
            d.sizeClass = Vocabulary.normalize(Vocabulary.SIZE_WORDS, d.sizeClass);
            d.env = Vocabulary.normalize(Vocabulary.ENV_WORDS, d.env);
            d.diskTier = Vocabulary.normalize(Vocabulary.TIER_WORDS, d.diskTier);
            d.notes.add(0, "source:" + name());
            return d;
        } catch (Exception e) {
            log.warn("LLM interpretation failed ({}); using rules instead", e.getMessage());
            IntentDraft d = fallback.extract(text);
            d.notes.add(0, "source:" + fallback.name() + " (LLM unavailable)");
            return d;
        }
    }
}
