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
 *  - with mode=entra, the Entra ID OAuth 2.0 flows and a plain bearer-token option are listed,
 *    required on every operation, and 401/403 responses are documented.
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
            boolean on = props.entraEnabled();
            if (on) {
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
                if (on) {
                    op.addSecurityItem(new SecurityRequirement().addList(OAUTH));
                    op.addSecurityItem(new SecurityRequirement().addList(BEARER));
                    op.getResponses().addApiResponse("401",
                            new ApiResponse().description("Missing, expired or invalid token").content(errorBody));
                    if (!op.getResponses().containsKey("403")) {
                        op.getResponses().addApiResponse("403",
                                new ApiResponse().description("Token lacks the required role").content(errorBody));
                    }
                }
            }));
        };
    }

    static ApiAccessRules.Role roleFor(AntPathMatcher matcher, PathItem.HttpMethod method, String path) {
        String normalized = path.replaceAll("\\{[^}]+}", "x");   // /requests/{id}/confirm -> /requests/x/confirm
        for (ApiAccessRules.Rule r : ApiAccessRules.RULES) {
            if (r.method().name().equals(method.name()) && matcher.match(r.pattern(), normalized)) return r.role();
        }
        return null;
    }
}
