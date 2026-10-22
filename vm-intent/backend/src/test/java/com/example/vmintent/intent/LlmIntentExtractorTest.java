package com.example.vmintent.intent;

import com.example.vmintent.config.AppConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Each AI provider, against a stand-in server on this machine that records what it receives
 * and answers the way that provider does.
 */
class LlmIntentExtractorTest {

    private static final String TEXT = "Ubuntu box, 4 cores, 16 gigs, us-east on AWS";
    private static final String DRAFT_JSON =
            "{\"provider\":\"Amazon\",\"region\":\"us-east\",\"vcpu\":4,\"memoryGiB\":16,\"os\":\"Ubuntu\"}";

    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private String base;
    /** What the stand-in received, one entry per call. */
    private final List<Map<String, String>> calls = new ArrayList<>();
    /** How the stand-in answers: request body -> {status, body}. */
    private volatile Function<JsonNode, Object[]> reply;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> call = new ConcurrentHashMap<>();
            call.put("path", ex.getRequestURI().toString());
            call.put("body", body);
            ex.getRequestHeaders().forEach((k, v) -> call.put("h:" + k.toLowerCase(), v.get(0)));
            synchronized (calls) {
                calls.add(call);
            }
            Object[] r = reply.apply(json.readTree(body));
            if ((int) r[0] == -1) {   // simulate a hung service
                try { Thread.sleep(3000); } catch (InterruptedException ignored) { }
                r = new Object[]{200, "{}"};
            }
            byte[] out = ((String) r[1]).getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("content-type", "application/json");
            ex.sendResponseHeaders((int) r[0], out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private String openAiReply(String content) throws IOException {
        return json.writeValueAsString(Map.of("choices", List.of(Map.of("message", Map.of("role", "assistant", "content", content)))));
    }

    private LlmIntentExtractor extractor(LlmProvider p, String url, String model, String key) {
        return new LlmIntentExtractor(new LlmIntentExtractor.Settings(p, url, model, key, Duration.ofSeconds(2)),
                new RuleBasedIntentExtractor());
    }

    private static void assertGoodDraft(IntentDraft d, String source) {
        assertEquals("source:" + source, d.notes.get(0));
        assertEquals("aws", d.provider);          // "Amazon" normalized
        assertEquals("ubuntu", d.os);             // "Ubuntu" normalized
        assertEquals(4, d.vcpu);
        assertEquals(16, d.memoryGiB);
    }

    @Test
    void anthropic() throws Exception {
        String answer = "{\"content\":[{\"type\":\"text\",\"text\":" + json.writeValueAsString(DRAFT_JSON) + "}]}";
        reply = body -> new Object[]{200, answer};
        IntentDraft d = extractor(LlmProvider.ANTHROPIC, base, "claude-sonnet-5-5", "sk-ant-test").extract(TEXT);
        assertGoodDraft(d, "ai:anthropic/claude-sonnet-5-5");
        Map<String, String> c = calls.get(0);
        assertEquals("/v1/messages", c.get("path"));
        assertEquals("sk-ant-test", c.get("h:x-api-key"));
        assertEquals("2023-06-01", c.get("h:anthropic-version"));
        JsonNode b = json.readTree(c.get("body"));
        assertEquals("claude-sonnet-5-5", b.get("model").asText());
        assertTrue(b.get("system").asText().contains("Reply with ONE JSON object"));
        assertEquals(TEXT, b.get("messages").get(0).get("content").asText());
    }

    @Test
    void openAi() throws Exception {
        String answer = openAiReply("```json\n" + DRAFT_JSON + "\n```");   // wrapped in a code fence
        reply = body -> new Object[]{200, answer};
        IntentDraft d = extractor(LlmProvider.OPENAI, base + "/v1", "some-model", "sk-test").extract(TEXT);
        assertGoodDraft(d, "ai:openai/some-model");
        Map<String, String> c = calls.get(0);
        assertEquals("/v1/chat/completions", c.get("path"));
        assertEquals("Bearer sk-test", c.get("h:authorization"));
        JsonNode b = json.readTree(c.get("body"));
        assertEquals("system", b.get("messages").get(0).get("role").asText());
        assertEquals("user", b.get("messages").get(1).get("role").asText());
        assertEquals(TEXT, b.get("messages").get(1).get("content").asText());
        assertEquals(0, b.get("temperature").asInt());
    }

    @Test
    void azureOpenAi() throws Exception {
        String answer = openAiReply(DRAFT_JSON);
        reply = body -> new Object[]{200, answer};
        IntentDraft d = extractor(LlmProvider.AZURE_OPENAI, base, "my-deployment", "az-key").extract(TEXT);
        assertGoodDraft(d, "ai:azure-openai/my-deployment");
        Map<String, String> c = calls.get(0);
        assertEquals("/openai/v1/chat/completions", c.get("path"));   // completed from the resource address
        assertEquals("Bearer az-key", c.get("h:authorization"));
        assertEquals("az-key", c.get("h:api-key"));
        assertEquals("my-deployment", json.readTree(c.get("body")).get("model").asText());
    }

    @Test
    void ollamaNeedsNoKeyAndCopesWithThinking() throws Exception {
        // A reasoning model thinks out loud first, braces and all.
        String answer = openAiReply("<think>They said {4 cores}, so vcpu=4.</think>\nHere you go: " + DRAFT_JSON);
        reply = body -> new Object[]{200, answer};
        IntentDraft d = extractor(LlmProvider.OLLAMA, base, "llama3.2", null).extract(TEXT);
        assertGoodDraft(d, "ai:ollama/llama3.2");
        Map<String, String> c = calls.get(0);
        assertEquals("/v1/chat/completions", c.get("path"));
        assertNull(c.get("h:authorization"));
    }

    @Test
    void retriesWithoutOptionsAModelRefuses() throws Exception {
        reply = body -> body.has("temperature")
                ? new Object[]{400, "{\"error\":{\"message\":\"Unsupported value: 'temperature' does not support 0 with this model.\"}}"}
                : new Object[]{200, uncheckedReply(DRAFT_JSON)};
        LlmIntentExtractor x = extractor(LlmProvider.OPENAI, base, "reasoning-model", "sk-test");
        assertGoodDraft(x.extract(TEXT), "ai:openai/reasoning-model");
        assertEquals(2, calls.size());
        assertFalse(json.readTree(calls.get(1).get("body")).has("max_tokens"));
        x.extract(TEXT);   // remembered: one call, no retry
        assertEquals(3, calls.size());
        assertFalse(json.readTree(calls.get(2).get("body")).has("temperature"));
    }

    private String uncheckedReply(String content) {
        try {
            return openAiReply(content);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void fallsBackToTheRules() {
        LlmIntentExtractor x = extractor(LlmProvider.OPENAI, base, "m", "bad-key");
        reply = body -> new Object[]{401, "{\"error\":\"bad key\"}"};
        IntentDraft d = x.extract(TEXT);
        assertEquals("source:rules (AI unavailable)", d.notes.get(0));
        assertEquals("aws", d.provider);                       // the rules still understood it
        reply = body -> new Object[]{200, uncheckedReply("Sorry, I can't help with that.")};
        assertEquals("source:rules (AI unavailable)", x.extract(TEXT).notes.get(0));
        reply = body -> new Object[]{-1, ""};                  // hangs past the 2 s timeout
        assertEquals("source:rules (AI unavailable)", x.extract(TEXT).notes.get(0));
        server.stop(0);                                        // nothing listening at all
        assertEquals("source:rules (AI unavailable)", x.extract(TEXT).notes.get(0));
    }

    @Test
    void endpointsAreCompletedFromABaseAddress() {
        assertEquals("http://localhost:11434/v1/chat/completions", LlmProvider.OLLAMA.endpoint(""));
        assertEquals("http://gpu-box:11434/v1/chat/completions", LlmProvider.OLLAMA.endpoint("http://gpu-box:11434/"));
        assertEquals("https://api.openai.com/v1/chat/completions", LlmProvider.OPENAI.endpoint(null));
        assertEquals("https://api.example.com/v1/chat/completions", LlmProvider.OPENAI.endpoint("https://api.example.com/v1"));
        assertEquals("https://x.openai.azure.com/openai/v1/chat/completions",
                LlmProvider.AZURE_OPENAI.endpoint("https://x.openai.azure.com"));
        assertEquals("https://x.openai.azure.com/openai/v1/chat/completions",
                LlmProvider.AZURE_OPENAI.endpoint("https://x.openai.azure.com/openai/v1/chat/completions"));
        assertEquals("https://api.anthropic.com/v1/messages", LlmProvider.ANTHROPIC.endpoint(""));
        assertThrows(IllegalStateException.class, () -> LlmProvider.AZURE_OPENAI.endpoint(""));
    }

    @Test
    void settingIsForgiving() {
        assertEquals(LlmProvider.NONE, LlmProvider.parse(""));
        assertEquals(LlmProvider.NONE, LlmProvider.parse("off"));
        assertEquals(LlmProvider.OLLAMA, LlmProvider.parse(" Ollama "));
        assertEquals(LlmProvider.AZURE_OPENAI, LlmProvider.parse("azure_openai"));
        assertEquals(LlmProvider.ANTHROPIC, LlmProvider.parse("claude"));
        assertThrows(IllegalStateException.class, () -> LlmProvider.parse("chatgpt"));
    }

    @Test
    void startupChecksTheSettings() {
        AppConfig cfg = new AppConfig();
        assertEquals("rules", cfg.intentExtractor("none", false, "", "", "", 0).name());
        assertEquals("ai:ollama/llama3.2", cfg.intentExtractor("ollama", false, "", "", "", 0).name());
        assertEquals("ai:ollama/qwen3", cfg.intentExtractor("ollama", false, "qwen3", "http://gpu-box:11434", "", 0).name());
        // Missing pieces stop startup with a message saying what to set.
        if (System.getenv("OPENAI_API_KEY") == null) {
            var e = assertThrows(IllegalStateException.class, () -> cfg.intentExtractor("openai", false, "m", "", "", 0));
            assertTrue(e.getMessage().contains("VMINTENT_LLM_API_KEY"));
        }
        var e2 = assertThrows(IllegalStateException.class, () -> cfg.intentExtractor("azure-openai", false, "", "https://x", "k", 0));
        assertTrue(e2.getMessage().contains("deployment name"));
    }
}
