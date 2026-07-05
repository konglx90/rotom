import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 中文文档:仓库根 /docs/*.md
const docs = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "../../docs",
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

// 英文文档:仓库根 /docs/en/*.md(与中文版镜像)
const docsEn = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "../../docs/en",
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
});

export const collections = { docs, docsEn };
