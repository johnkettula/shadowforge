import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, "/api/..." calls and the API docs are forwarded to the Spring Boot app on port 8080.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // also reachable from other devices on your network, at http://<this PC's IP>:5173
    proxy: {
      "/api": "http://localhost:8080",
      "/v3/api-docs": "http://localhost:8080",
      "/swagger-ui": "http://localhost:8080",
    },
  },
});
