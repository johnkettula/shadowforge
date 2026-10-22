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
import java.util.Locale;

/**
 * Asks an AI model to fill in the IntentDraft fields as JSON. The model only reports what the
 * user said; Vocabulary normalizes its values and PolicyDefaults fills the gaps, exactly as for
 * the rule-based path. If the call fails for any reason, the rule-based extractor answers instead.
 *
 * Two request formats cover every provider (see LlmProvider): Anthropic's Messages API, and the
 * OpenAI chat-completions format used by OpenAI, Azure OpenAI, Ollama and many others.
 */
public class LlmIntentExtractor implements IntentExtractor {

    private static final Logger log = LoggerFactory.getLogger(LlmIntentExtractor.class);

    static final String SYSTEM_PROMPT = """
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

    /** What to call and how. */
    public record Settings(LlmProvider provider, String url, String model, String apiKey, Duration timeout) {}

    private final Settings s;
    private final IntentExtractor fallback;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ObjectMapper json = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /** Set once a service refuses temperature / max_tokens (some newer models do); later calls skip them. */
    private volatile boolean bareRequests = false;

    public LlmIntentExtractor(Settings settings, IntentExtractor fallback) {
        this.s = settings;
        this.fallback = fallback;
    }

    @Override
    public String name() {
        return "ai:" + s.provider().id + "/" + s.model();
    }

    @Override
    public IntentDraft extract(String text) {
        try {
            IntentDraft d = parseDraft(ask(text));
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
            log.warn("AI interpretation via {} failed ({}); using the rules instead", name(), describe(e));
            IntentDraft d = fallback.extract(text);
            d.notes.add(0, "source:" + fallback.name() + " (AI unavailable)");
            return d;
        }
    }

    /** Sends the request and returns the model's text answer. */
    String ask(String text) throws Exception {
        HttpResponse<String> resp = http.send(request(text, bareRequests), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() == 400 && !bareRequests && mentionsUnsupportedOption(resp.body())) {
            log.info("{} refused temperature/max_tokens; sending plain requests from now on", name());
            bareRequests = true;
            resp = http.send(request(text, true), HttpResponse.BodyHandlers.ofString());
        }
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("HTTP " + resp.statusCode() + ": " + shorten(resp.body()));
        }
        JsonNode root = json.readTree(resp.body());
        JsonNode answer = s.provider().format == LlmProvider.Format.ANTHROPIC
                ? root.path("content").path(0).path("text")
                : root.path("choices").path(0).path("message").path("content");
        if (!answer.isTextual() || answer.asText().isBlank()) {
            throw new IllegalStateException("no text in the reply: " + shorten(resp.body()));
        }
        return answer.asText();
    }

    HttpRequest request(String text, boolean bare) throws Exception {
        ObjectNode body = json.createObjectNode();
        body.put("model", s.model());
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(s.provider().endpoint(s.url())))
                .timeout(s.timeout())
                .header("content-type", "application/json");
        if (s.provider().format == LlmProvider.Format.ANTHROPIC) {
            body.put("max_tokens", 400);
            body.put("temperature", 0);
            body.put("system", SYSTEM_PROMPT);
            ObjectNode msg = body.putArray("messages").addObject();
            msg.put("role", "user");
            msg.put("content", text);
            req.header("x-api-key", s.apiKey()).header("anthropic-version", "2023-06-01");
        } else {
            if (!bare) {
                body.put("temperature", 0);
                body.put("max_tokens", 400);
            }
            var messages = body.putArray("messages");
            messages.addObject().put("role", "system").put("content", SYSTEM_PROMPT);
            messages.addObject().put("role", "user").put("content", text);
            if (s.apiKey() != null && !s.apiKey().isBlank()) {
                req.header("Authorization", "Bearer " + s.apiKey());
                if (s.provider() == LlmProvider.AZURE_OPENAI) req.header("api-key", s.apiKey());
            }
        }
        return req.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
    }

    /**
     * Finds the JSON object in the model's answer. Models sometimes wrap it in prose or code fences,
     * and reasoning models may "think out loud" (between <think> tags) first.
     */
    IntentDraft parseDraft(String answer) throws Exception {
        String a = answer.replaceAll("(?s)<think>.*?</think>", "");
        Exception last = null;
        for (int start = a.indexOf('{'); start >= 0; start = a.indexOf('{', start + 1)) {
            int end = matchingBrace(a, start);
            if (end < 0) continue;
            try {
                JsonNode node = json.readTree(a.substring(start, end + 1));
                if (node.isObject()) return json.treeToValue(node, IntentDraft.class);
            } catch (Exception e) {
                last = e;
            }
        }
        throw new IllegalStateException("no JSON object in the reply" + (last == null ? "" : " (" + last.getMessage() + ")"));
    }

    private static int matchingBrace(String s, int start) {
        int depth = 0;
        boolean inString = false;
        for (int i = start; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inString) {
                if (c == '\\') i++;
                else if (c == '"') inString = false;
            } else if (c == '"') {
                inString = true;
            } else if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return i;
            }
        }
        return -1;
    }

    /** A readable reason: some network errors carry no message of their own. */
    private String describe(Exception e) {
        String where = s.provider().endpoint(s.url());
        if (e instanceof java.net.ConnectException) {
            return "can't connect to " + where + (s.provider() == LlmProvider.OLLAMA ? ": is Ollama running?" : "");
        }
        if (e instanceof java.net.http.HttpTimeoutException) {
            return "no answer from " + where + " within " + s.timeout().toSeconds() + " s";
        }
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName() + " calling " + where;
    }

    private static boolean mentionsUnsupportedOption(String body) {
        String b = body == null ? "" : body.toLowerCase(Locale.ROOT);
        return (b.contains("temperature") || b.contains("max_tokens"))
                && (b.contains("unsupported") || b.contains("not supported") || b.contains("does not support"));
    }

    private static String shorten(String s) {
        if (s == null) return "";
        s = s.replaceAll("\\s+", " ");
        return s.length() > 200 ? s.substring(0, 200) + "..." : s;
    }
}
