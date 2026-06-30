import { defineConfig } from "astro/config";

// 静态站点,独立部署,与 master / dashboard 无任何耦合
export default defineConfig({
  site: "https://rotom.example.com",
  output: "static",
  base: "/",
  trailingSlash: "ignore",
  build: {
    inlineStylesheets: "auto",
  },
  devToolbar: { enabled: false },
});
