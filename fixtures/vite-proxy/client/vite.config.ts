import { defineConfig } from "vite";

// Read as syntax only: the analyzer never loads or runs a config.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // `/api/users` reaches the server's `/users`.
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, ""),
      },
      // Sent on unchanged.
      "/auth": "http://localhost:5000",
      // An outside API: an external call, not a route in the repo.
      "/weather": { target: "https://api.weather.example.com", changeOrigin: true },
    },
  },
});
