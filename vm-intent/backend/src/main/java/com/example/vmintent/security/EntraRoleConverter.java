package com.example.vmintent.security;

import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Turns an Entra ID access token into a vm-intent caller.
 *
 * Roles come from two claims:
 *  - "roles": app roles, assigned to users, groups or (for services) other applications;
 *  - "scp":   delegated scopes a user consented to, space-separated.
 * Each value is looked up in the role map (defaults below). Unknown values are ignored, so a
 * token with none of them can sign in but can't do anything.
 *
 * The caller's name, used in the audit trail, is the user's sign-in name, or for a service
 * calling as itself, "app:" plus its client ID.
 */
public class EntraRoleConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    public static final Map<String, String> DEFAULT_ROLE_MAP = Map.of(
            "VmIntent.Admin", "ADMIN",
            "VmIntent.Batch", "BATCH",
            "VmIntent.Request", "REQUESTER",
            "VmIntent.Read", "READER");

    private final Map<String, String> roleMap;

    public EntraRoleConverter(Map<String, String> roleMap) {
        this.roleMap = roleMap == null || roleMap.isEmpty() ? DEFAULT_ROLE_MAP : roleMap;
    }

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        Set<GrantedAuthority> authorities = new LinkedHashSet<>();
        for (String value : claimValues(jwt)) {
            String role = roleMap.get(value);
            if (role != null) authorities.add(new SimpleGrantedAuthority("ROLE_" + role.trim().toUpperCase()));
        }
        return new JwtAuthenticationToken(jwt, authorities, callerName(jwt));
    }

    static String callerName(Jwt jwt) {
        for (String claim : List.of("preferred_username", "upn", "unique_name", "email")) {
            String v = jwt.getClaimAsString(claim);
            if (v != null && !v.isBlank()) return v;
        }
        String app = jwt.getClaimAsString("azp") != null ? jwt.getClaimAsString("azp") : jwt.getClaimAsString("appid");
        if (app != null) return "app:" + app;
        return jwt.getSubject();
    }

    private static Collection<String> claimValues(Jwt jwt) {
        Set<String> values = new LinkedHashSet<>();
        List<String> roles = jwt.getClaimAsStringList("roles");
        if (roles != null) values.addAll(roles);
        String scp = jwt.getClaimAsString("scp");
        if (scp != null) values.addAll(List.of(scp.trim().split("\\s+")));
        return values;
    }
}
