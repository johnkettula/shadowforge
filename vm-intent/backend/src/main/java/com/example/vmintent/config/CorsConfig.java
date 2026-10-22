package com.example.vmintent.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.Arrays;

/**
 * Which other web pages may call the API from a browser (CORS).
 *
 * The web app doesn't need this: its dev server (Vite) and nginx pass its calls on as the same site.
 * This is for a page served from somewhere else, such as another team's portal. List its address in
 * vmintent.api.cors-origins (env VMINTENT_CORS_ORIGINS, comma-separated). Patterns are allowed:
 * "https://*.example.com", "http://localhost:[*]" (any port).
 *
 * Services calling from their own code (not a browser) are never affected by CORS.
 */
@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class CorsConfig implements WebMvcConfigurer {

    private final String[] origins;

    public CorsConfig(@Value("${vmintent.api.cors-origins:http://localhost:[*],http://127.0.0.1:[*]}") String origins) {
        this.origins = Arrays.stream(origins.split(",")).map(String::trim).filter(s -> !s.isEmpty())
                .toArray(String[]::new);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        if (origins.length == 0) return;
        registry.addMapping("/api/**")
                .allowedOriginPatterns(origins)
                .allowedMethods("GET", "POST", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
