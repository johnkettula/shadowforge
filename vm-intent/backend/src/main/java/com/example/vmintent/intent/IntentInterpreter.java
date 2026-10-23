package com.example.vmintent.intent;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.SpecValidator;
import com.example.vmintent.spec.VmSpec;

import java.util.ArrayList;
import java.util.List;

/**
 * The full pipeline from words to a validated, hashed spec:
 * extract -> defaults -> validate -> canonicalize + hash.
 * Plain Java (no Spring, no Temporal) so it is easy to unit test.
 */
public class IntentInterpreter {

    private final IntentExtractor extractor;

    public IntentInterpreter(IntentExtractor extractor) {
        this.extractor = extractor;
    }

    public Interpretation interpret(String text) {
        IntentDraft draft = extractor.extract(text);
        String source = extractor.name();
        if (!draft.notes.isEmpty() && draft.notes.get(0).startsWith("source:")) {
            source = draft.notes.remove(0).substring("source:".length());
        }
        return fromDraft(text, source, draft);
    }

    public Interpretation fromDraft(String text, String source, IntentDraft draft) {
        String question = PolicyDefaults.missingQuestion(draft);
        if (question != null) {
            return new Interpretation(text, source, null, null, null, List.of(), question);
        }

        List<String> assumptions = new ArrayList<>(draft.notes);
        VmSpec spec = PolicyDefaults.apply(draft, assumptions);

        List<String> problems = SpecValidator.problems(spec);
        if (!problems.isEmpty()) {
            return new Interpretation(text, source, null, null, null, assumptions,
                    String.join(" ", problems) + " What should I change?");
        }

        String hash = SpecCanonicalizer.hash(spec);
        VmSpec named = SpecCanonicalizer.withGeneratedName(spec, hash);
        int count = draft.count == null || draft.count < 1 ? 1 : draft.count;
        String summary = PolicyDefaults.summary(named);
        if (count > 1) {
            summary = count + " × " + summary;
            assumptions.add(count + " identical VMs, named " + named.name() + "-01 to " + named.name()
                    + String.format("-%02d", count) + ".");
        }
        return new Interpretation(text, source, named, hash, summary,
                List.copyOf(assumptions), null, count > 1 ? count : null);
    }
}
