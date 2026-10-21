package com.example.vmintent.config;

import com.example.vmintent.intent.IntentExtractor;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.LlmIntentExtractor;
import com.example.vmintent.intent.RuleBasedIntentExtractor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AppConfig {

    @Bean
    public IntentExtractor intentExtractor(
            @Value("${vmintent.llm.enabled:false}") boolean llmEnabled,
            @Value("${vmintent.llm.api-key:}") String apiKey,
            @Value("${vmintent.llm.model}") String model,
            @Value("${vmintent.llm.url}") String url) {
        IntentExtractor rules = new RuleBasedIntentExtractor();
        if (llmEnabled && !apiKey.isBlank()) {
            return new LlmIntentExtractor(apiKey, model, url, rules);
        }
        return rules;
    }

    @Bean
    public IntentInterpreter intentInterpreter(IntentExtractor extractor) {
        return new IntentInterpreter(extractor);
    }
}
