package com.example.vmintent.config;

import com.example.vmintent.intent.IntentExtractor;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.LlmIntentExtractor;
import com.example.vmintent.intent.LlmProvider;
import com.example.vmintent.intent.RuleBasedIntentExtractor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.stream.Stream;

@Configuration
public class AppConfig {

    private static final Logger log = LoggerFactory.getLogger(AppConfig.class);

    /**
     * The interpreter: the built-in rules, or an AI model with the rules as fallback.
     * Settings: vmintent.llm.* in application.yml (env VMINTENT_LLM_PROVIDER, _MODEL, _URL, _API_KEY,
     * _TIMEOUT_SECONDS). See LlmProvider for the choices.
     */
    @Bean
    public IntentExtractor intentExtractor(
            @Value("${vmintent.llm.provider:none}") String providerName,
            @Value("${vmintent.llm.enabled:false}") boolean legacyEnabled,
            @Value("${vmintent.llm.model:}") String model,
            @Value("${vmintent.llm.url:}") String url,
            @Value("${vmintent.llm.api-key:}") String apiKey,
            @Value("${vmintent.llm.timeout-seconds:0}") int timeoutSeconds) {
        IntentExtractor rules = new RuleBasedIntentExtractor();
        LlmProvider provider = LlmProvider.parse(providerName);
        if (provider == LlmProvider.NONE && legacyEnabled) provider = LlmProvider.ANTHROPIC;   // old setting
        if (provider == LlmProvider.NONE) {
            log.info("Interpreter: built-in rules (no AI). Set VMINTENT_LLM_PROVIDER to use one.");
            return rules;
        }

        String key = firstNonBlank(apiKey, switch (provider) {
            case ANTHROPIC -> System.getenv("ANTHROPIC_API_KEY");
            case OPENAI -> System.getenv("OPENAI_API_KEY");
            case AZURE_OPENAI -> System.getenv("AZURE_OPENAI_API_KEY");
            default -> null;
        });
        if (provider.needsKey && key == null) {
            throw new IllegalStateException("vmintent.llm.provider=" + provider.id
                    + " needs an API key: set VMINTENT_LLM_API_KEY (or "
                    + (provider == LlmProvider.ANTHROPIC ? "ANTHROPIC_API_KEY" : provider == LlmProvider.OPENAI
                    ? "OPENAI_API_KEY" : "AZURE_OPENAI_API_KEY") + ")");
        }
        String m = firstNonBlank(model, provider.defaultModel);
        if (m == null) {
            throw new IllegalStateException("vmintent.llm.provider=" + provider.id + " needs a model: set VMINTENT_LLM_MODEL"
                    + (provider == LlmProvider.AZURE_OPENAI ? " to your deployment name" : " (see your provider's model list)"));
        }
        Duration timeout = Duration.ofSeconds(timeoutSeconds > 0 ? timeoutSeconds : provider.defaultTimeoutSeconds);
        var settings = new LlmIntentExtractor.Settings(provider, url, m, key, timeout);
        log.info("Interpreter: AI via {} (model {}, {}), falling back to the built-in rules if it fails",
                provider.id, m, provider.endpoint(url));
        return new LlmIntentExtractor(settings, rules);
    }

    private static String firstNonBlank(String... values) {
        return Stream.of(values).filter(v -> v != null && !v.isBlank()).map(String::trim).findFirst().orElse(null);
    }

    @Bean
    public IntentInterpreter intentInterpreter(IntentExtractor extractor) {
        return new IntentInterpreter(extractor);
    }
}
