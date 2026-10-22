import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, "/api/..." calls and the API docs are forwarded to the Spring Boot app on port 8080.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // also reachable from other devices on your network, at http://<this PC's IP>:5173
    // changeOrigin: false keeps the address you opened (e.g. 192.168.4.39:5173), so the backend sees
    // these calls as coming from the same site and doesn't apply cross-site (CORS) checks.
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: false },
      "/v3/api-docs": { target: "http://localhost:8080", changeOrigin: false },
      "/swagger-ui": { target: "http://localhost:8080", changeOrigin: false },
    },
  },
});
