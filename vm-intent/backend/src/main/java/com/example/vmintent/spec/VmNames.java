package com.example.vmintent.spec;

import java.util.regex.Pattern;

/**
 * The one VM-name rule for new requests: lower-case letters, digits and hyphens, 2 to 41 characters,
 * not starting with a hyphen. 41 leaves room for a multi-VM "-NN" ending and a per-user suffix in the
 * cloud name while staying under DNS's 63 characters. Bad names are rejected, never rewritten:
 * lower-casing would change the spec hash and so duplicate detection.
 */
public final class VmNames {

    /** The rule as a regex fragment, for patterns that pick a name out of longer text. */
    public static final String REGEX = "[a-z0-9][a-z0-9-]{1,40}";
    public static final int MAX_LENGTH = 41;

    private static final Pattern PATTERN = Pattern.compile(REGEX);

    private VmNames() {}

    public static boolean isValid(String name) {
        return name != null && PATTERN.matcher(name).matches();
    }
}
