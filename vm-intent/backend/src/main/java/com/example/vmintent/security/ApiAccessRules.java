package com.example.vmintent.security;

import org.springframework.http.HttpMethod;

import java.util.List;

/**
 * Who may call what. One table, used both to enforce access (SecurityConfig) and to document it
 * in the OpenAPI document (each operation's "Required role"), so the two can't disagree.
 *
 * Roles, from most to least powerful (each includes the ones below it):
 *   ADMIN      everything
 *   BATCH      bulk and legacy creation, for services; includes READER
 *   REQUESTER  one-at-a-time requests (interpret, create, answer, confirm, cancel); includes READER
 *   READER     read-only: inventory, stats, audit, request and batch status
 */
public final class ApiAccessRules {

    public enum Role { ADMIN, BATCH, REQUESTER, READER }

    /** Role hierarchy in Spring Security's notation. */
    public static final String HIERARCHY = """
            ROLE_ADMIN > ROLE_BATCH
            ROLE_ADMIN > ROLE_REQUESTER
            ROLE_BATCH > ROLE_READER
            ROLE_REQUESTER > ROLE_READER
            """;

    /** method + Ant-style path pattern -> least role needed. First match wins. */
    public record Rule(HttpMethod method, String pattern, Role role) {}

    public static final List<Rule> RULES = List.of(
            new Rule(HttpMethod.POST, "/api/v2/batches", Role.BATCH),
            new Rule(HttpMethod.POST, "/api/v1/vms", Role.BATCH),
            new Rule(HttpMethod.POST, "/api/v2/interpret", Role.REQUESTER),
            new Rule(HttpMethod.POST, "/api/v2/requests", Role.REQUESTER),
            new Rule(HttpMethod.POST, "/api/v2/requests/*/clarify", Role.REQUESTER),
            new Rule(HttpMethod.POST, "/api/v2/requests/*/confirm", Role.REQUESTER),
            new Rule(HttpMethod.POST, "/api/v2/requests/*/cancel", Role.REQUESTER),
            new Rule(HttpMethod.GET, "/api/**", Role.READER));

    /** Always open, so callers can discover the API before they have a token. */
    public static final String[] PUBLIC = {"/v3/api-docs", "/v3/api-docs/**", "/v3/api-docs.yaml",
            "/swagger-ui.html", "/swagger-ui/**", "/error"};

    private ApiAccessRules() {}
}
