import { defineConfig } from "vite";
import { gsx } from "@gsxhq/vite-plugin-gsx";

// Example dev config: Vite is the front door and proxies non-Vite routes to the
// Go server, so the injected @vite/client socket survives Go rebuilds.
export default defineConfig({
  plugins: [
    gsx({
      // Default is ["go","tool","gsx","generate"]; override for a custom cmd/gsx:
      // command: ["go", "run", "./cmd/gsx", "generate"],
    }),
  ],
  server: {
    proxy: {
      "^(?!/@vite|/@id|/node_modules).*": {
        target: "http://localhost:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
