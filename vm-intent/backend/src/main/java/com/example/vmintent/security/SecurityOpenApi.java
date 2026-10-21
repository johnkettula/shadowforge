package com.example.vmintent.security;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.PathItem;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.responses.ApiResponse;
import io.swagger.v3.oas.models.security.OAuthFlow;
import io.swagger.v3.oas.models.security.OAuthFlows;
import io.swagger.v3.oas.models.security.Scopes;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.util.AntPathMatcher;

/**
 * Puts sign-in into the OpenAPI document:
 *  - every operation's description ends with the role it needs (from ApiAccessRules);
 *  - the overview says which sign-in methods are on;
 *  - with Entra ID on, its OAuth 2.0 flows and a plain bearer-token option are listed and required
 *    on every operation (OpenAPI 3.0 has no way to declare client certificates, so those are
 *    described in the overview and in the x-client-certificate extension);
 *  - with any sign-in on, 401/403 responses are documented.
 */
@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityOpenApi {

    static final String OAUTH = "entraId";
    static final String BEARER = "bearerToken";

    @Bean
    public OpenApiCustomizer securityDocs(SecurityProperties props) {
        AntPathMatcher matcher = new AntPathMatcher();
        return openApi -> {
            boolean on = props.enabled();
            if (openApi.getInfo() != null) {
                String d = openApi.getInfo().getDescription() == null ? "" : openApi.getInfo().getDescription();
                if (!d.contains("**Sign-in.**")) openApi.getInfo().setDescription(d.stripTrailing() + "\n\n" + signInText(props));
            }
            if (props.pkiEnabled()) {
                openApi.addExtension("x-client-certificate", java.util.Map.of(
                        "required", !props.entraEnabled(),
                        "description", "Mutual TLS: present a client certificate issued by a trusted CA "
                                + "and listed on the API's allowlist."));
            }
            if (props.entraEnabled()) {
                SecurityProperties.Entra e = props.entra();
                String base = "https://login.microsoftonline.com/" + e.tenantId() + "/oauth2/v2.0";
                String appUri = e.audiences().stream().filter(a -> a.startsWith("api://")).findFirst()
                        .orElse("api://" + e.audiences().get(0));
                Scopes userScopes = new Scopes()
                        .addString(appUri + "/VmIntent.Request", "Make and manage VM requests")
                        .addString(appUri + "/VmIntent.Read", "Read inventory, status and audit");
                Scopes appScopes = new Scopes().addString(appUri + "/.default",
                        "The app roles your service was granted (VmIntent.Batch, VmIntent.Read, ...)");
                if (openApi.getComponents() == null) openApi.setComponents(new Components());
                openApi.getComponents()
                        .addSecuritySchemes(OAUTH, new SecurityScheme().type(SecurityScheme.Type.OAUTH2)
                                .description("Microsoft Entra ID. People: authorization code. Services: client credentials.")
                                .flows(new OAuthFlows()
                                        .authorizationCode(new OAuthFlow().authorizationUrl(base + "/authorize")
                                                .tokenUrl(base + "/token").scopes(userScopes))
                                        .clientCredentials(new OAuthFlow().tokenUrl(base + "/token").scopes(appScopes))))
                        .addSecuritySchemes(BEARER, new SecurityScheme().type(SecurityScheme.Type.HTTP)
                                .scheme("bearer").bearerFormat("JWT")
                                .description("Paste an Entra ID access token for this API."));
            }
            Content errorBody = new Content().addMediaType("application/json",
                    new MediaType().schema(new Schema<>().$ref("#/components/schemas/ApiError")));
            openApi.getPaths().forEach((path, item) -> item.readOperationsMap().forEach((method, op) -> {
                ApiAccessRules.Role role = roleFor(matcher, method, path);
                if (role == null) return;
                String note = "\n\n**Required role:** " + role
                        + (on ? "" : " (when sign-in is on; it is currently off)");
                op.setDescription((op.getDescription() == null ? op.getSummary() : op.getDescription()) + note);
                if (props.entraEnabled()) {
                    op.addSecurityItem(new SecurityRequirement().addList(OAUTH));
                    op.addSecurityItem(new SecurityRequirement().addList(BEARER));
                }
                if (on) {
                    op.getResponses().addApiResponse("401", new ApiResponse()
                            .description("Not signed in: missing or invalid token, or a refused client certificate")
                            .content(errorBody));
                    if (!op.getResponses().containsKey("403")) {
                        op.getResponses().addApiResponse("403",
                                new ApiResponse().description("Signed in without the required role").content(errorBody));
                    }
                }
            }));
        };
    }

    static String signInText(SecurityProperties props) {
        if (!props.enabled()) {
            return "**Sign-in.** Off on this server: restrict access at the network level. See the "
                    + "\"Required role\" on each operation for what applies when sign-in is on.\n";
        }
        StringBuilder b = new StringBuilder("**Sign-in.** Every `/api` call needs ");
        String token = "a Microsoft Entra ID access token (`Authorization: Bearer <token>`; services use the "
                + "client-credentials flow)";
        String cert = "a client certificate (mutual TLS) issued by a CA this API trusts and listed on its "
                + "allowlist, which gives the certificate its role";
        if (props.entraEnabled() && props.pkiEnabled()) b.append(token).append(", or ").append(cert);
        else b.append(props.entraEnabled() ? token : cert);
        return b.append(". Each operation lists its **Required role**: ADMIN, BATCH, REQUESTER or READER. ")
                .append("A missing or refused credential gets 401; a missing role gets 403.\n").toString();
    }

    static ApiAccessRules.Role roleFor(AntPathMatcher matcher, PathItem.HttpMethod method, String path) {
        String normalized = path.replaceAll("\\{[^}]+}", "x");   // /requests/{id}/confirm -> /requests/x/confirm
        for (ApiAccessRules.Rule r : ApiAccessRules.RULES) {
            if (r.method().name().equals(method.name()) && matcher.match(r.pattern(), normalized)) return r.role();
        }
        return null;
    }
}
