import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://rotom.example.com",
  output: "static",
  base: "/",
  trailingSlash: "ignore",
  build: {
    inlineStylesheets: "auto",
  },
  devToolbar: { enabled: false },
  markdown: {
    shikiConfig: {
      theme: "github-light",
    },
  },
});
