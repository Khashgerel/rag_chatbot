import { NextResponse } from "next/server";
import { getGitHubModelsClient } from "@/src/lib/githubModels";
import { embedText } from "@/src/lib/embeddings";
import { searchRag } from "@/src/lib/rag";

const CHAT_MODEL = process.env.RAG_CHAT_MODEL || "openai/gpt-4o";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = String(body?.message ?? "").trim();
    if (!message) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const qVec = await embedText(message);

    const hits = await searchRag(qVec, 6);

    const context = hits
      .map(
        (h, idx) =>
          `[#${idx + 1}] SOURCE: ${h.source} | FILE: ${h.file} | CHUNK: ${
            h.chunk_index
          }\n${h.chunk}`
      )
      .join("\n\n---\n\n");

    const client = getGitHubModelsClient();

    const response = await client.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "You answer using ONLY the provided context. If the answer is not in the context, say you don't know and ask for the missing part. You must answer in Mongolian. Be creative and engaging in your responses.",
        },
        {
          role: "system",
          content: `CONTEXT:\n\n${context || "(no matches found)"}`,
        },
        { role: "user", content: message },
      ],
    });

    const reply = response.choices?.[0]?.message?.content ?? "";

    return NextResponse.json({
      reply,
      citations: hits.map((h) => ({
        source: h.source,
        file: h.file,
        path: h.path,
        chunk_index: h.chunk_index,
        score: h.score,
      })),
    });
  } catch (err: any) {
    console.error("chat route error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal error" },
      { status: 500 }
    );
  }
}
