import { getGitHubModelsClient } from "./githubModels";

const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "openai/text-embedding-3-small";

export async function embedText(text: string): Promise<number[]> {
  const client = getGitHubModelsClient();

  const resp = await client.embeddings.create({
    model: EMBED_MODEL,
    input: text
  });

  const vec = resp.data?.[0]?.embedding;
  if (!vec || !Array.isArray(vec)) throw new Error("Embedding failed / empty embedding.");
  return vec;
}
