package com.example.vmintent.legacy;

import com.example.vmintent.intent.IntentDraft;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.intent.Vocabulary;
import org.springframework.stereotype.Component;

/**
 * Converts the legacy JSON into the same draft the AI produces, so legacy
 * callers get exactly the same defaults, validation and hash — just no LLM.
 */
@Component
public class LegacySpecTranslator {

    private final IntentInterpreter interpreter;

    public LegacySpecTranslator(IntentInterpreter interpreter) {
        this.interpreter = interpreter;
    }

    public Interpretation translate(LegacyVmDefinition in) {
        IntentDraft d = new IntentDraft();
        d.name = in.name();
        d.provider = Vocabulary.normalize(Vocabulary.PROVIDER_WORDS, in.cloud());
        d.region = Vocabulary.normalize(Vocabulary.REGION_WORDS, in.location());
        d.vcpu = in.cpu();
        d.memoryGiB = in.ramGb();
        if (in.image() != null) {
            d.os = Vocabulary.normalize(Vocabulary.OS_WORDS, in.image().os());
            d.osVersion = in.image().version();
        }
        if (in.disk() != null) {
            d.diskGiB = in.disk().sizeGb();
            d.diskTier = Vocabulary.normalize(Vocabulary.TIER_WORDS, in.disk().type());
        }
        d.env = Vocabulary.normalize(Vocabulary.ENV_WORDS, in.environment());
        d.ttlDays = in.ttlDays();
        d.publicIp = in.publicIp();
        return interpreter.fromDraft("(legacy JSON)", "legacy-json", d);
    }
}
