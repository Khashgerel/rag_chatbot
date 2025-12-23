import { getDbClient } from "./db";

export type RagHit = {
  source: string;
  file: string;
  path: string;
  chunk_index: number;
  chunk: string;
  score: number;
};

function toVectorLiteral(v: number[]) {
  return `[${v.map((x) => Number(x).toString()).join(",")}]`;
}

export async function searchRag(embedding: number[], k = 15): Promise<RagHit[]> {
  const db = getDbClient();
  await db.connect();

  try {
    const vec = toVectorLiteral(embedding);

    const r = await db.query(
      `
      SELECT
        COALESCE(metadata->>'source', 'unknown') AS source,
        COALESCE(metadata->>'file',   '')        AS file,
        COALESCE(metadata->>'path',   '')        AS path,
        COALESCE((metadata->>'chunk_index')::int, 0) AS chunk_index,
        content AS chunk,
        (embedding <=> $1::vector) AS score
      FROM rag_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2
      `,
      [vec, k]
    );

    return r.rows.map((x: any) => ({
      source: String(x.source),
      file: String(x.file),
      path: String(x.path),
      chunk_index: Number(x.chunk_index),
      chunk: String(x.chunk),
      score: Number(x.score),
    }));
  } finally {
    await db.end();
  }
}
