import "../src/env.js";

import { readFileSync } from "node:fs";
import path from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

interface Pattern {
  id: number;
  description: string;
  category: "exploit" | "benign" | "edge_case";
  risk_level: "critical" | "high" | "medium" | "low";
}

async function main(): Promise<void> {
  if (!process.env.QDRANT_URL) {
    console.error("QDRANT_URL is not set. Add it to .env.local or .env before seeding.");
    process.exit(1);
  }

  const collection = process.env.QDRANT_COLLECTION ?? "ptb_patterns";

  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  });

  // gemini-embedding-001 (3072-dim) — text-embedding-004 was retired by
  // Google and now 404s. The LangChain wrapper does not expose
  // outputDimensionality, so we store the native 3072-dim vectors.
  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
  });

  const patternsPath = path.resolve(process.cwd(), "data/patterns.json");
  const patterns: Pattern[] = JSON.parse(readFileSync(patternsPath, "utf-8"));
  console.log(`Loaded ${patterns.length} patterns from ${patternsPath}`);

  // Recreate from scratch so re-seeding is idempotent even when the vector
  // dimension or pattern set changes.
  try {
    await qdrant.deleteCollection(collection);
    console.log(`Deleted existing collection "${collection}"`);
  } catch {
    // did not exist — fine
  }
  await qdrant.createCollection(collection, {
    vectors: { size: 3072, distance: "Cosine" },
  });
  console.log(`Created collection "${collection}"`);

  const points: {
    id: number;
    vector: number[];
    payload: { description: string; category: string; risk_level: string };
  }[] = [];

  for (const pattern of patterns) {
    const vector = await embeddings.embedQuery(pattern.description);
    points.push({
      id: pattern.id,
      vector,
      payload: {
        description: pattern.description,
        category: pattern.category,
        risk_level: pattern.risk_level,
      },
    });
    console.log(`Embedded pattern ${pattern.id}/${patterns.length} [${pattern.category}]`);
  }

  await qdrant.upsert(collection, { wait: true, points });
  console.log(`Upserted ${points.length} points into "${collection}"`);
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
