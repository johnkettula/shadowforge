package com.example.vmintent.config;

import com.example.vmintent.workflow.RequestSearch;
import io.temporal.api.enums.v1.IndexedValueType;
import io.temporal.api.operatorservice.v1.AddSearchAttributesRequest;
import io.temporal.api.operatorservice.v1.ListSearchAttributesRequest;
import io.temporal.client.WorkflowClient;
import io.temporal.common.SearchAttributeKey;
import io.temporal.serviceclient.OperatorServiceStubs;
import io.temporal.serviceclient.OperatorServiceStubsOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * Makes sure the Temporal server knows the search attributes in RequestSearch (VmRequester,
 * VmState, ...), so requests can be listed and filtered.
 *
 * A Temporal server refuses a workflow that sets an attribute it doesn't know, so this checks
 * first, adds any that are missing (the dev server and a self-hosted server allow that), and
 * only then lets new requests use them. If the server won't add them (Temporal Cloud, or no
 * permission), requests still work; they just can't be filtered until someone adds them:
 *   temporal operator search-attribute create --name VmRequester --type Keyword   (and the others)
 *
 * vmintent.search-attributes: auto (default) or off.
 */
@Component
public class SearchAttributesSetup {

    private static final Logger log = LoggerFactory.getLogger(SearchAttributesSetup.class);

    private final WorkflowClient client;
    private final boolean wanted;
    private volatile Boolean ready;

    public SearchAttributesSetup(WorkflowClient client, @Value("${vmintent.search-attributes:auto}") String setting) {
        this.client = client;
        this.wanted = !"off".equalsIgnoreCase(setting.trim());
    }

    /** True once every attribute exists on the server. Checked on first use, then remembered. */
    public boolean enabled() {
        Boolean r = ready;
        if (r == null) {
            synchronized (this) {
                if (ready == null) ready = wanted && setUp();
                r = ready;
            }
        }
        return r;
    }

    /** Ask again (e.g. after someone added the attributes by hand). */
    public void recheck() {
        ready = null;
    }

    private boolean setUp() {
        String ns = client.getOptions().getNamespace();
        OperatorServiceStubs ops = null;
        try {
            ops = OperatorServiceStubs.newServiceStubs(OperatorServiceStubsOptions.newBuilder()
                    .setChannel(client.getWorkflowServiceStubs().getRawChannel())
                    .validateAndBuildWithDefaults());
            Set<String> missing = missing(ops, ns);
            if (missing.isEmpty()) {
                log.info("Search attributes ready: requests can be listed and filtered");
                return true;
            }
            Map<String, IndexedValueType> add = new TreeMap<>();
            for (String name : missing) add.put(name, IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD);
            ops.blockingStub().addSearchAttributes(AddSearchAttributesRequest.newBuilder()
                    .setNamespace(ns).putAllSearchAttributes(add).build());
            // The server takes a moment to make new attributes usable.
            for (int i = 0; i < 20 && !missing(ops, ns).isEmpty(); i++) Thread.sleep(250);
            boolean ok = missing(ops, ns).isEmpty();
            log.info(ok ? "Added search attributes {}" : "Asked the server to add search attributes {}, but they aren't there yet",
                    missing);
            return ok;
        } catch (Exception e) {
            log.warn("Search attributes aren't available ({}). Requests still work but can't be filtered. "
                    + "To turn filtering on, create these Keyword attributes on the server: {}",
                    e.getMessage(), RequestSearch.ALL.stream().map(SearchAttributeKey::getName).toList());
            return false;
        } finally {
            if (ops != null) ops.shutdown();
        }
    }

    private static Set<String> missing(OperatorServiceStubs ops, String ns) {
        Set<String> have = ops.blockingStub()
                .listSearchAttributes(ListSearchAttributesRequest.newBuilder().setNamespace(ns).build())
                .getCustomAttributesMap().keySet();
        return RequestSearch.ALL.stream().map(SearchAttributeKey::getName)
                .filter(n -> !have.contains(n)).collect(Collectors.toCollection(java.util.TreeSet::new));
    }
}
