package com.example.vmintent.intent;

/** Turns free text into a draft. Swap implementations (rules, LLM) freely. */
public interface IntentExtractor {
    IntentDraft extract(String text);

    String name();
}
