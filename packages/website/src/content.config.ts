import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, "../docs");
const docsEnDir = path.resolve(__dirname, "../docs/en");

// 中文文档
const docs = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: docsDir,
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

// 英文文档
const docsEn = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: docsEnDir,
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

export const collections = { docs, docsEn };
