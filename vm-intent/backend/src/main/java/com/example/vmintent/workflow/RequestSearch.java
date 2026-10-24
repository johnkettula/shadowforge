package com.example.vmintent.workflow;

import io.temporal.common.SearchAttributeKey;

import java.util.List;

/**
 * Search attributes: extra fields on each request workflow that Temporal indexes, so requests can
 * be listed and filtered (GET /api/v2/requests?requester=...&state=...) and searched in the
 * Temporal UI, e.g.  VmRequester = "jdoe" AND VmState = "AWAITING_CONFIRMATION".
 *
 * A Temporal server only accepts attributes it knows. SearchAttributesSetup registers these at
 * startup (the dev server allows that); 1-start-temporal.cmd also creates them.
 */
public final class RequestSearch {
    public static final SearchAttributeKey<String> REQUESTER = SearchAttributeKey.forKeyword("VmRequester");
    public static final SearchAttributeKey<String> STATE = SearchAttributeKey.forKeyword("VmState");
    public static final SearchAttributeKey<String> PROVIDER = SearchAttributeKey.forKeyword("VmProvider");
    public static final SearchAttributeKey<String> ENV = SearchAttributeKey.forKeyword("VmEnv");
    public static final SearchAttributeKey<String> SPEC_HASH = SearchAttributeKey.forKeyword("VmSpecHash");

    /** Catalog runs: which definition the run follows (name). */
    public static final SearchAttributeKey<String> DEFINITION = SearchAttributeKey.forKeyword("VmDefinition");
    /** Catalog runs: the data classification code, which decides how long the run is kept. */
    public static final SearchAttributeKey<String> CLASSIFICATION = SearchAttributeKey.forKeyword("VmClassification");

    public static final List<SearchAttributeKey<String>> ALL =
            List.of(REQUESTER, STATE, PROVIDER, ENV, SPEC_HASH, DEFINITION, CLASSIFICATION);

    private RequestSearch() {}
}
