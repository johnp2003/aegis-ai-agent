import "../src/env.js";

import { QdrantClient } from "@qdrant/js-client-rest";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

async function main(): Promise<void> {
  if (!process.env.QDRANT_URL) {
    console.error("QDRANT_URL is not set. Add it to .env.local or .env before searching.");
    process.exit(1);
  }

  const collection = process.env.QDRANT_COLLECTION ?? "ptb_patterns";

  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  });

  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
  });

  const query = "unregistered contract requesting NFT custody transfer and capability deletion";
  console.log(`Query: ${query}`);

  const vector = await embeddings.embedQuery(query);
  const response = await qdrant.query(collection, { query: vector, limit: 3, with_payload: true });
  const results = response.points ?? [];

  if (results.length === 0) {
    console.error("No results returned — is the collection seeded?");
    process.exit(1);
  }

  for (const result of results) {
    const payload = result.payload as { description: string; category: string; risk_level: string };
    console.log(`Score: ${(result.score ?? 0).toFixed(3)} [${payload.category}] ${payload.description}`);
  }

  const topCategory = (results[0].payload as { category: string }).category;
  if (topCategory !== "exploit") {
    console.error(`Top result category is "${topCategory}", expected "exploit"`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Search test failed:", err);
  process.exit(1);
});
