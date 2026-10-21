package com.example.vmintent.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.responses.ApiResponse;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import io.swagger.v3.oas.models.servers.Server;
import io.swagger.v3.oas.models.tags.Tag;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Arrays;
import java.util.List;

/**
 * The OpenAPI (Swagger) document for the REST API.
 *
 *   /v3/api-docs        OpenAPI 3 JSON  (point client generators here)
 *   /v3/api-docs.yaml   the same, as YAML
 *   /swagger-ui.html    interactive Swagger UI
 *
 * The document is generated from the controllers at startup, so it always matches the code.
 * Set vmintent.api.server-urls (env VMINTENT_API_SERVER_URLS, comma-separated) to list the
 * addresses other services should call; otherwise the document uses the address it was fetched from.
 */
@Configuration
public class OpenApiConfig {

    private static final String DESCRIPTION = """
            Request virtual machines on vSphere, AWS, Azure or Google Cloud, in plain English or as an exact spec.

            **How it works.** Every request becomes one canonical, cloud-neutral spec with a SHA-256 hash. The same \
            spec can't be built twice at once: the hash is the build's identity. A Temporal workflow builds each VM \
            and rolls it back (deletes it) if anything fails.

            **Typical flows**
            - *One VM, with a human in the loop:* `POST /api/v2/requests`, poll `GET /api/v2/requests/{id}`, then \
            `/clarify` if it asks a question and `/confirm` to build.
            - *Many VMs from a service:* `POST /api/v2/batches` with specs or text, then poll \
            `GET /api/v2/batches/{id}`. No confirmation step per VM.
            - *Check first:* `POST /api/v2/interpret` shows what a text would become, without building anything.

            **Optional fields.** Fields with no value are left out of responses rather than sent as null.

            **Errors.** Every 4xx and 5xx response has the body `{"error": "..."}`.

            **Authentication.** None yet: restrict access at the network level (the Azure template allows only \
            listed IP ranges). Add an API gateway or Entra ID before exposing this beyond a sandbox.
            """;

    @Bean
    public OpenAPI vmIntentOpenApi(@Value("${vmintent.api.server-urls:}") String serverUrls,
                                   @Value("${vmintent.api.version:2.0.0}") String version) {
        OpenAPI api = new OpenAPI()
                .info(new Info()
                        .title("vm-intent API")
                        .version(version)
                        .description(DESCRIPTION)
                        .license(new License().name("Internal use")))
                .tags(List.of(
                        new Tag().name("Requests").description("One VM at a time: interpret, clarify, confirm, build"),
                        new Tag().name("Batches").description("Many VMs at once, no confirmation per VM"),
                        new Tag().name("Inventory").description("VMs, counts and the audit trail"),
                        new Tag().name("Legacy").description("The old universal JSON format (v1)")));
        List<Server> servers = Arrays.stream(serverUrls.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .map(url -> new Server().url(url))
                .toList();
        if (!servers.isEmpty()) api.servers(servers);
        return api;
    }

    /**
     * Every operation lists the shared error body: 400 for any operation that takes a body
     * (invalid JSON), and 500 for all. Keeps the document true to what the server sends.
     */
    @Bean
    public OpenApiCustomizer contractFixes() {
        return openApi -> {
            Content errorBody = new Content().addMediaType("application/json",
                    new MediaType().schema(new Schema<>().$ref("#/components/schemas/ApiError")));
            openApi.getPaths().values().forEach(path -> path.readOperations().forEach(op -> {
                if (op.getRequestBody() != null && !op.getResponses().containsKey("400")) {
                    op.getResponses().addApiResponse("400",
                            new ApiResponse().description("Invalid request body").content(errorBody));
                }
                if (!op.getResponses().containsKey("500")) {
                    op.getResponses().addApiResponse("500",
                            new ApiResponse().description("Unexpected server error").content(errorBody));
                }
            }));
        };
    }
}
