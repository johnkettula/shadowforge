package com.example.vmintent.intent;

import java.util.Arrays;
import java.util.Locale;

/**
 * The AI services the interpreter can call. Picked with vmintent.llm.provider
 * (env VMINTENT_LLM_PROVIDER).
 *
 *   none          no AI: the built-in rules only (default; works offline)
 *   anthropic     Claude, through Anthropic's Messages API
 *   openai        OpenAI, or any service with an OpenAI-compatible chat completions API
 *   azure-openai  Azure OpenAI (the model is your deployment name)
 *   ollama        Ollama on this machine or your network: free, local, no key
 *
 * Every AI choice speaks one of two request formats, so adding another
 * OpenAI-compatible service is just a URL, a model name and a key.
 */
public enum LlmProvider {

    NONE("none", null, null, false, null, 0),
    ANTHROPIC("anthropic", Format.ANTHROPIC, "https://api.anthropic.com/v1/messages", true, "claude-sonnet-5-5", 30),
    OPENAI("openai", Format.OPENAI, "https://api.openai.com/v1/chat/completions", true, null, 30),
    AZURE_OPENAI("azure-openai", Format.OPENAI, null, true, null, 30),
    // Local models load on first use and run on the CPU if there's no GPU: give them longer.
    OLLAMA("ollama", Format.OPENAI, "http://localhost:11434/v1/chat/completions", false, "llama3.2", 120);

    /** The two request/response shapes. */
    public enum Format { ANTHROPIC, OPENAI }

    public final String id;
    public final Format format;
    public final String defaultUrl;
    public final boolean needsKey;
    public final String defaultModel;
    public final int defaultTimeoutSeconds;

    LlmProvider(String id, Format format, String defaultUrl, boolean needsKey, String defaultModel,
                int defaultTimeoutSeconds) {
        this.id = id;
        this.format = format;
        this.defaultUrl = defaultUrl;
        this.needsKey = needsKey;
        this.defaultModel = defaultModel;
        this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    }

    public static LlmProvider parse(String value) {
        String v = value == null ? "" : value.trim().toLowerCase(Locale.ROOT).replace('_', '-');
        if (v.isEmpty() || v.equals("off") || v.equals("false") || v.equals("rules")) return NONE;
        if (v.equals("claude")) return ANTHROPIC;
        if (v.equals("azure")) return AZURE_OPENAI;
        return Arrays.stream(values()).filter(p -> p.id.equals(v)).findFirst()
                .orElseThrow(() -> new IllegalStateException("vmintent.llm.provider: unknown value '" + value
                        + "'. Use none, anthropic, openai, azure-openai or ollama."));
    }

    /**
     * The full endpoint URL. A base address is completed with the usual path, so
     * "http://gpu-box:11434", "https://myres.openai.azure.com" or "https://api.example.com/v1" all work.
     */
    public String endpoint(String configured) {
        String url = configured == null || configured.isBlank() ? defaultUrl : configured.trim();
        if (url == null) {
            throw new IllegalStateException("vmintent.llm.provider=" + id + " needs vmintent.llm.url (env VMINTENT_LLM_URL), "
                    + "e.g. https://<your-resource>.openai.azure.com");
        }
        url = url.replaceAll("/+$", "");
        if (format == Format.ANTHROPIC) {
            return url.endsWith("/messages") ? url : url + (url.endsWith("/v1") ? "" : "/v1") + "/messages";
        }
        if (url.endsWith("/chat/completions")) return url;
        if (url.endsWith("/v1")) return url + "/chat/completions";
        if (this == AZURE_OPENAI) return url + (url.endsWith("/openai") ? "" : "/openai") + "/v1/chat/completions";
        return url + "/v1/chat/completions";
    }
}
