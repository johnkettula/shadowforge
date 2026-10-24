package com.example.vmintent.security;

import com.example.vmintent.audit.DecisionLog;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationEventPublisher;
import org.springframework.security.authorization.AuthorizationResult;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;

import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Writes every API authorization decision to the decision log: Spring Security calls this for each
 * request it lets through or refuses. With sign-in off, every request is allowed and logged as such.
 *
 * vmintent.audit.log-reads=false leaves out allowed GETs (the web app reads a lot); refusals and
 * every change are always logged.
 */
@Component
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class ApiDecisionPublisher implements AuthorizationEventPublisher {

    private static final Pattern RUN_PATH = Pattern.compile("^/api/v2/runs/([A-Za-z0-9._-]+)(/.*)?$");
    private final AntPathMatcher paths = new AntPathMatcher();

    private final DecisionLog log;
    private final JdbcClient jdbc;
    private final SecurityProperties props;
    private final boolean logReads;

    public ApiDecisionPublisher(DecisionLog log, JdbcClient jdbc, SecurityProperties props,
                                @Value("${vmintent.audit.log-reads:true}") boolean logReads) {
        this.log = log;
        this.jdbc = jdbc;
        this.props = props;
        this.logReads = logReads;
    }

    @Override
    public <T> void publishAuthorizationEvent(Supplier<Authentication> authentication, T object, AuthorizationDecision decision) {
        publish(authentication, object, decision);
    }

    @Override
    public <T> void publishAuthorizationEvent(Supplier<Authentication> authentication, T object, AuthorizationResult result) {
        publish(authentication, object, result);
    }

    private <T> void publish(Supplier<Authentication> authentication, T object, AuthorizationResult result) {
        if (!(object instanceof HttpServletRequest req) || result == null) return;
        String path = req.getRequestURI().substring(req.getContextPath().length());
        if (!path.startsWith("/api/")) return;
        boolean allowed = result.isGranted();
        if (allowed && "GET".equals(req.getMethod()) && !logReads) return;

        Authentication a = authentication.get();
        boolean signedIn = a != null && a.isAuthenticated() && !(a instanceof AnonymousAuthenticationToken);
        String actor = signedIn ? a.getName() : "anonymous";
        String roles = signedIn ? a.getAuthorities().stream().map(g -> g.getAuthority().replaceFirst("^ROLE_", ""))
                .sorted().collect(Collectors.joining(",")) : null;

        String policy;
        String reason;
        if (!props.enabled()) {
            policy = "sign-in off";
            reason = "vmintent.security.mode=none lets every request through";
        } else {
            ApiAccessRules.Rule rule = ApiAccessRules.RULES.stream()
                    .filter(r -> r.method().matches(req.getMethod()) && paths.match(r.pattern(), path))
                    .findFirst().orElse(null);
            policy = rule == null ? "no rule: refused" : "role rule " + rule.method() + " " + rule.pattern() + " needs " + rule.role();
            reason = allowed ? "has the role" : !signedIn ? "not signed in" : "doesn't have the role";
        }
        // A run's calls are filed under the run's ID, so one search finds every decision about it.
        Matcher run = RUN_PATH.matcher(path);
        String resource = run.matches() ? run.group(1) : path;
        log.record(actor, roles, req.getMethod() + " " + path, resource, allowed, policy, reason, classificationOf(path));
    }

    /** A run's own classification for its URLs; otherwise the default (null). */
    private String classificationOf(String path) {
        Matcher m = RUN_PATH.matcher(path);
        if (!m.matches()) return null;
        return jdbc.sql("SELECT classification FROM catalog_run WHERE workflow_id = :id ORDER BY started_at DESC LIMIT 1")
                .param("id", m.group(1)).query(String.class).optional().orElse(null);
    }
}
