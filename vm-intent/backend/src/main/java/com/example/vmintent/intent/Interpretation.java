package com.example.vmintent.intent;

import com.example.vmintent.spec.VmSpec;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

/**
 * The result of interpreting one request.
 *
 * @param question   non-null when we need the user to answer something
 *                   before we can build a spec (spec is then null)
 * @param assumptions every default we filled in, shown to the user
 */
@Schema(description = "What a request was understood to mean. Either spec/specHash are set, or question is.")
public record Interpretation(
        @Schema(description = "The text that was interpreted.") String text,
        @Schema(description = "Which interpreter was used.", example = "rules") String extractor,
        VmSpec spec,
        @Schema(description = "The VM's identity: the SHA-256 of the canonical spec. For a signed-in user the hash also covers the user ID, so each user gets their own VM.",
                example = "3af19a4e8492dc7edd60f92413fe0567546acd258f9c214eaebca7c4dd0d5d72") String specHash,
        @Schema(description = "One-line summary.") String summary,
        @Schema(description = "Defaults that were filled in.") List<String> assumptions,
        @Schema(description = "Set when something must be answered before a spec can be built.",
                example = "Which platform should this run on: vSphere (on-prem), AWS, Azure or Google Cloud?")
        String question,
        @Schema(description = "How many identical VMs were asked for. Left out when it's one.", example = "3")
        Integer count,
        @Schema(description = "The VM's name in its cloud: the same as spec.name, except that a signed-in user's named VM gets '-' plus the first 8 characters of specHash after it (web-01-3af19a4e). Left out when a question is asked.",
                example = "web-01")
        String cloudName
) {
    public Interpretation(String text, String extractor, VmSpec spec, String specHash, String summary,
                          List<String> assumptions, String question) {
        this(text, extractor, spec, specHash, summary, assumptions, question, null);
    }

    /** Without a cloud name, as recorded before it existed (null = the VM's cloud name is spec.name). */
    public Interpretation(String text, String extractor, VmSpec spec, String specHash, String summary,
                          List<String> assumptions, String question, Integer count) {
        this(text, extractor, spec, specHash, summary, assumptions, question, count, null);
    }

    /** How many VMs to build: 1 unless the request asked for more. */
    public int vmCount() {
        return count == null || count < 1 ? 1 : count;
    }
}
