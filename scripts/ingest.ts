import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import os from "node:os";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const pdfParse = require("pdf-parse");
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";

import { createWorker } from "tesseract.js";
import { Client } from "pg";

import OpenAI from "openai";
import { chunkText } from "../src/lib/chunker";

const POLICIES_DIR = path.join(process.cwd(), "data", "policies");
const TESSDATA_DIR = path.join(process.cwd(), "scripts", "tessdata");

const token = process.env.GITHUB_TOKEN!;
const endpoint = "https://models.github.ai/inference";
const embedModel =
  process.env.RAG_EMBED_MODEL || "openai/text-embedding-3-small";

// ---- Rate limit controls (tune as needed) ----
const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 2); // 1-3 is usually safe
const EMBED_MIN_DELAY_MS = Number(process.env.EMBED_MIN_DELAY_MS ?? 150); // add spacing between calls

// Simple concurrency limiter (no extra deps)
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (e) {
          reject(e);
        } finally {
          active--;
          next();
        }
      });
      next();
    });
  };
}

const limitEmbed = createLimiter(Math.max(1, EMBED_CONCURRENCY));

// Reuse ONE client (important)
const openaiClient = (() => {
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  return new OpenAI({ baseURL: endpoint, apiKey: token });
})();

let lastEmbedCallAt = 0;
async function paceEmbeds() {
  const now = Date.now();
  const elapsed = now - lastEmbedCallAt;
  if (elapsed < EMBED_MIN_DELAY_MS) {
    await sleep(EMBED_MIN_DELAY_MS - elapsed);
  }
  lastEmbedCallAt = Date.now();
}

function getClient() {
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  return new OpenAI({ baseURL: endpoint, apiKey: token });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, tries = 8) {
  let lastErr: any;

  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;

      const status = e?.status ?? e?.response?.status;
      const headers = e?.response?.headers ?? e?.headers ?? {};
      const retryAfterRaw =
        headers["retry-after"] ?? headers["Retry-After"] ?? undefined;

      // GitHub/edge services sometimes return 403 for "secondary rate limit"
      const isRateLimit = status === 429 || status === 403;

      if (!isRateLimit) throw e;

      let wait = Math.min(60_000, 1000 * 2 ** i) + Math.floor(Math.random() * 500);

      // Honor Retry-After if present
      if (retryAfterRaw) {
        const sec = Number(retryAfterRaw);
        if (!Number.isNaN(sec) && sec > 0) {
          wait = Math.max(wait, sec * 1000);
        }
      }

      console.log(`Rate limited (${status}). Retry ${i + 1}/${tries} in ${wait}ms...`);
      await sleep(wait);
    }
  }

  throw lastErr;
}


async function parsePdf(buffer: Buffer) {
  return pdfParse(buffer);
}

async function embed(text: string): Promise<number[]> {
  return limitEmbed(async () => {
    await paceEmbeds();

    const resp = await withRetry(() =>
      openaiClient.embeddings.create({
        model: embedModel,
        input: text,
      })
    );

    const vec = resp.data?.[0]?.embedding;
    if (!vec) throw new Error("Embedding failed.");
    return vec;
  });
}


function toVectorLiteral(v: number[]) {
  if (!Array.isArray(v) || v.length === 0)
    throw new Error("Empty embedding vector");
  return `[${v.map((x) => Number(x).toString()).join(",")}]`;
}

async function ensureSchema(db: Client) {
  // show exactly where we are connected (prints in your terminal)
  const info = await db.query(
    "SELECT current_database() db, current_user usr, inet_server_port() port, version() v"
  );
  console.log("DB INFO:", info.rows[0]);

  // pgvector + table (safe to run every time)
  await db.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.rag_chunks (
      id bigserial PRIMARY KEY,
      source text NOT NULL,
      page int NOT NULL,
      chunk_index int NOT NULL,
      chunk text NOT NULL,
      embedding vector(1536) NOT NULL
    );
  `);

  const chk = await db.query(`SELECT to_regclass('public.rag_chunks') AS tbl;`);
  console.log("TABLE CHECK:", chk.rows[0]); // should print public.rag_chunks
}

async function ocrPdfToText(
  pdfPath: string
): Promise<{ text: string; pages: number }> {
  const worker = await createWorker("eng+mon", 1, {
    langPath: TESSDATA_DIR,
    gzip: false,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-ocr-"));
  const outPrefix = path.join(tmpDir, "page");

  execFileSync("pdftoppm", ["-png", "-r", "300", pdfPath, outPrefix], {
    stdio: "ignore",
  });

  const images = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
    .sort((a, b) => {
      const pa = Number(a.match(/page-(\d+)\.png/)?.[1] ?? 0);
      const pb = Number(b.match(/page-(\d+)\.png/)?.[1] ?? 0);
      return pa - pb;
    });

  let fullText = "";

  for (const imgName of images) {
    const pageNum = Number(imgName.match(/page-(\d+)\.png/)?.[1] ?? 0);
    const imgPath = path.join(tmpDir, imgName);

    const { data } = await worker.recognize(imgPath);
    fullText += `\n\n[PAGE ${pageNum}]\n${data.text || ""}`;
  }

  await worker.terminate();

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  return { text: fullText.trim(), pages: images.length };
}

async function extractTextSmart(
  pdfBuffer: Buffer,
  pdfPath: string
): Promise<{ text: string; usedOcr: boolean }> {
  const parsed = await parsePdf(pdfBuffer);
  const t = (parsed.text || "").trim();

  if (t.length < 300) {
    const ocr = await ocrPdfToText(pdfPath);
    return { text: ocr.text, usedOcr: true };
  }

  return { text: t, usedOcr: false };
}

function splitByPages(text: string): Array<{ page: number; content: string }> {
  // Uses markers like [PAGE N] from OCR. If not found, treat as page=1.
  const parts = text.split(/\[PAGE\s+(\d+)\]/g);
  if (parts.length <= 1) return [{ page: 1, content: text }];

  const out: Array<{ page: number; content: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const content = (parts[i + 1] || "").trim();
    if (content) out.push({ page, content });
  }
  return out.length ? out : [{ page: 1, content: text }];
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("Missing DATABASE_URL");
  console.log("DB URL loaded:", !!process.env.DATABASE_URL);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  await ensureSchema(db);

  const files = fs
    .readdirSync(POLICIES_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    console.log("No PDFs found in:", POLICIES_DIR);
    await db.end();
    return;
  }

  for (const file of files) {
    const filePath = path.join(POLICIES_DIR, file);
    const pdfBuffer = fs.readFileSync(filePath);
    const { text, usedOcr } = await extractTextSmart(pdfBuffer, filePath);

    console.log(
      `Parsed: ${file} (${usedOcr ? "OCR eng+mon" : "text"}) chars=${
        text.length
      }`
    );

    // If OCR used, we have [PAGE N] markers; if not, all is page 1
    const pages = usedOcr ? splitByPages(text) : [{ page: 1, content: text }];

    for (const p of pages) {
      const chunks = chunkText(p.content, 900, 150);

      for (let idx = 0; idx < chunks.length; idx++) {
        const ch = chunks[idx];
        const vec = await embed(ch);
        const vecLit = toVectorLiteral(vec);

        await db.query(
          `INSERT INTO public.rag_chunks (source, page, chunk_index, chunk, embedding)
   VALUES ($1, $2, $3, $4, $5::vector)`,
          [file, p.page, idx, ch, vecLit]
        );
      }
    }
  }

  await db.end();
  console.log("✅ Ingestion complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
