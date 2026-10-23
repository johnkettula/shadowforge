package com.example.vmintent.link;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * vmintent.link.*: which clouds sit behind the one-way link to domain 3, and where the link's
 * files go. See docs/ONE-WAY-LINK.md.
 *
 * @param oneWayProviders  comma-separated providers reached over the link, or * for all. Empty = none
 *                         (every cloud is called directly, as on a single PC).
 * @param outboxDir        orders are written here; the link software carries them to domain 3
 * @param inboxDir         the return link drops domain 3's answers here
 * @param replyTimeoutMinutes  how long a workflow waits for an answer before giving up (and undoing)
 * @param simulateDomain3  answer the orders here, as a pretend domain 3, for trying it out on one PC
 * @param simulatedBuildSeconds how long the pretend domain 3 takes to "build" a VM
 */
@ConfigurationProperties("vmintent.link")
public record LinkProperties(String oneWayProviders, Path outboxDir, Path inboxDir, int replyTimeoutMinutes,
                             boolean simulateDomain3, int simulatedBuildSeconds) {

    public LinkProperties {
        if (oneWayProviders == null) oneWayProviders = "";
        String home = System.getProperty("user.home");
        if (outboxDir == null) outboxDir = Path.of(home, ".vm-intent", "link", "outbox");
        if (inboxDir == null) inboxDir = Path.of(home, ".vm-intent", "link", "inbox");
        if (replyTimeoutMinutes <= 0) replyTimeoutMinutes = 120;
        if (simulatedBuildSeconds <= 0) simulatedBuildSeconds = 8;
    }

    public Set<String> providers() {
        return Arrays.stream(oneWayProviders.split(","))
                .map(p -> p.trim().toLowerCase(Locale.ROOT))
                .filter(p -> !p.isEmpty())
                .collect(Collectors.toSet());
    }

    public boolean isOneWay(String provider) {
        Set<String> p = providers();
        return p.contains("*") || p.contains(provider);
    }

    public boolean enabled() {
        return !providers().isEmpty();
    }
}
