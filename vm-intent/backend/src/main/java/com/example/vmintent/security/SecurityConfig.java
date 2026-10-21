package com.example.vmintent.security;

import com.example.vmintent.api.ApiModels.ApiError;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.access.hierarchicalroles.RoleHierarchyImpl;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;

import java.io.IOException;
import java.util.List;

/**
 * Sign-in and permissions for the REST API.
 *
 *   vmintent.security.mode = none   no sign-in (default; keep the API on a private network)
 *   vmintent.security.mode = entra  every /api call needs a Microsoft Entra ID access token
 *                                   ("Authorization: Bearer <token>"), and the token's app roles
 *                                   or scopes decide what the caller may do (see ApiAccessRules)
 *
 * The API docs (/v3/api-docs, /swagger-ui.html) stay open so callers can find out how to sign in.
 * Errors come back as the usual {"error": "..."} body: 401 for a missing or bad token, 403 for a
 * valid token without the needed role.
 *
 * Another sign-in method (for example a PKI/attribute service) can be added as a second
 * authentication mechanism in this same chain; the rules and roles don't change.
 */
@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)   // not in worker processes
@EnableConfigurationProperties(SecurityProperties.class)
public class SecurityConfig {

    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

    @Bean
    public RoleHierarchy roleHierarchy() {
        return RoleHierarchyImpl.fromHierarchy(ApiAccessRules.HIERARCHY);
    }

    @Bean
    public SecurityFilterChain apiSecurity(HttpSecurity http, SecurityProperties props, ObjectMapper json)
            throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)      // stateless bearer tokens: no cookies to forge
                .cors(Customizer.withDefaults())         // honours the controllers' @CrossOrigin
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable);

        if (!props.entraEnabled()) {
            log.warn("API sign-in is OFF (vmintent.security.mode=none). Keep the API on a private network.");
            http.authorizeHttpRequests(a -> a.anyRequest().permitAll());
            return http.build();
        }

        SecurityProperties.Entra entra = props.entra();
        if (entra.tenantId() == null || entra.tenantId().isBlank() || entra.audiences().isEmpty()) {
            throw new IllegalStateException(
                    "vmintent.security.mode=entra needs vmintent.security.entra.tenant-id and .audiences");
        }
        log.info("API sign-in: Entra ID tenant {}, audiences {}", entra.tenantId(), entra.audiences());

        http.authorizeHttpRequests(a -> {
            a.requestMatchers(ApiAccessRules.PUBLIC).permitAll();
            for (ApiAccessRules.Rule r : ApiAccessRules.RULES) {
                a.requestMatchers(r.method(), r.pattern()).hasRole(r.role().name());
            }
            a.anyRequest().denyAll();
        });
        http.oauth2ResourceServer(o -> o
                .jwt(j -> j.decoder(entraDecoder(entra)).jwtAuthenticationConverter(new EntraRoleConverter(entra.roleMap())))
                .authenticationEntryPoint((req, res, ex) -> writeError(res, json, 401,
                        "Sign in: send 'Authorization: Bearer <Entra ID access token>'. " + ex.getMessage()))
                .accessDeniedHandler((req, res, ex) -> writeError(res, json, 403,
                        "Your token doesn't have the role this operation needs. See the operation's "
                                + "'Required role' in /swagger-ui.html.")));
        http.exceptionHandling(e -> e
                .authenticationEntryPoint((req, res, ex) -> writeError(res, json, 401,
                        "Sign in: send 'Authorization: Bearer <Entra ID access token>'."))
                .accessDeniedHandler((req, res, ex) -> writeError(res, json, 403,
                        "Your token doesn't have the role this operation needs.")));
        return http.build();
    }

    /** Checks the signature (Entra's published keys), expiry, issuer and audience. */
    static JwtDecoder entraDecoder(SecurityProperties.Entra entra) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(entra.effectiveJwkSetUri()).build();
        List<String> issuers = entra.effectiveIssuers();
        List<String> audiences = entra.audiences();
        OAuth2TokenValidator<Jwt> issuer = jwt -> issuers.contains(jwt.getClaimAsString("iss"))
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token",
                        "Token issuer " + jwt.getClaimAsString("iss") + " is not this tenant", null));
        OAuth2TokenValidator<Jwt> audience = jwt -> jwt.getAudience() != null
                && jwt.getAudience().stream().anyMatch(audiences::contains)
                ? OAuth2TokenValidatorResult.success()
                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token",
                        "Token audience " + jwt.getAudience() + " is not this API", null));
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(new JwtTimestampValidator(), issuer, audience));
        return decoder;
    }

    private static void writeError(HttpServletResponse res, ObjectMapper json, int status, String message)
            throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        if (status == 401) res.setHeader("WWW-Authenticate", "Bearer");
        json.writeValue(res.getOutputStream(), ApiError.of(message));
    }
}
