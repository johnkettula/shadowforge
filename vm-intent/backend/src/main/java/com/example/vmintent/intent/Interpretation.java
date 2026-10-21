package com.example.vmintent.intent;

import com.example.vmintent.spec.VmSpec;

import java.util.List;

/**
 * The result of interpreting one request.
 *
 * @param question   non-null when we need the user to answer something
 *                   before we can build a spec (spec is then null)
 * @param assumptions every default we filled in, shown to the user
 */
public record Interpretation(
        String text,
        String extractor,
        VmSpec spec,
        String specHash,
        String summary,
        List<String> assumptions,
        String question
) {}
