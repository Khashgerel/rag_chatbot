import os, time, random, json, hashlib
from pathlib import Path
from typing import List, Dict, Any

import psycopg2
from dotenv import load_dotenv
from openai import OpenAI
from pypdf import PdfReader

load_dotenv()

DB = os.environ["DATABASE_URL"]
EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "text-embedding-3-small")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "128"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "8"))
MIN_DELAY_MS = int(os.getenv("MIN_DELAY_MS", "200"))

PDF_DIR = Path(os.getenv("PDF_DIR", "./data/policies")).resolve()

CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "1600"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))

client = OpenAI(
    base_url="https://models.inference.ai.azure.com",
    api_key=os.environ["GITHUB_TOKEN"],
)

_last_call = 0.0

def normalize_text(s: str) -> str:
    """Light cleanup to avoid giant whitespace blocks / null chars."""
    return " ".join((s or "").replace("\x00", " ").split())

def extract_pdf_text_textonly(pdf_path: Path) -> str:
    """
    Extracts text from a PDF using pypdf only.
    If a PDF page has no extractable text, it is skipped (no OCR fallback).
    """
    reader = PdfReader(str(pdf_path))
    pages: List[str] = []

    for page in reader.pages:
        t = normalize_text(page.extract_text() or "")
        if t:
            pages.append(t)

    return "\n".join(pages)

def make_chunks(text: str, chunk_chars: int, overlap: int) -> List[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    n = len(text)
    while start < n:
        end = min(n, start + chunk_chars)
        chunks.append(text[start:end])
        if end == n:
            break
        start = max(0, end - overlap)
    return chunks

def stable_id(*parts: str) -> str:
    return hashlib.sha1("||".join(parts).encode("utf-8")).hexdigest()

def pace():
    global _last_call
    now = time.time()
    elapsed = (now - _last_call) * 1000
    if elapsed < MIN_DELAY_MS:
        time.sleep((MIN_DELAY_MS - elapsed) / 1000)
    _last_call = time.time()

def with_retry(fn):
    last = None
    for i in range(MAX_RETRIES):
        try:
            return fn()
        except Exception as e:
            last = e
            wait = min(60, 2 ** i) + random.random()
            print(f"Retry {i+1}/{MAX_RETRIES} in {wait:.2f}s: {e}")
            time.sleep(wait)
    raise last

def embed_texts(texts: List[str]) -> List[List[float]]:
    pace()
    resp = with_retry(lambda: client.embeddings.create(
        model=EMBED_MODEL,
        input=texts
    ))
    return [d.embedding for d in resp.data]

def chunked(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i+n]

def upsert_chunks(chunks: List[Dict[str, Any]]):
    conn = psycopg2.connect(DB)
    cur = conn.cursor()

    for batch in chunked(chunks, BATCH_SIZE):
        texts = [c["text"] for c in batch]
        vectors = embed_texts(texts)

        for i, c in enumerate(batch):
            cur.execute(
                """
                INSERT INTO rag_chunks (id, content, metadata, embedding)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET content=EXCLUDED.content,
                    metadata=EXCLUDED.metadata,
                    embedding=EXCLUDED.embedding
                """,
                (c["id"], c["text"], json.dumps(c.get("metadata", {})), vectors[i])
            )

        conn.commit()
        print(f"Upserted {len(batch)} chunks")

    cur.close()
    conn.close()

def build_chunks_from_pdfs(pdf_dir: Path) -> List[Dict[str, Any]]:
    if not pdf_dir.exists():
        raise FileNotFoundError(f"PDF_DIR not found: {pdf_dir}")

    pdfs = sorted(pdf_dir.rglob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in: {pdf_dir}")
        return []

    all_chunks: List[Dict[str, Any]] = []

    for pdf_path in pdfs:
        print(f"Reading: {pdf_path}")
        text = extract_pdf_text_textonly(pdf_path)

        if not text.strip():
            print("  -> Skipped (no extractable text; likely scanned/image PDF)")
            continue

        chunks = make_chunks(text, CHUNK_CHARS, CHUNK_OVERLAP)
        for idx, ch in enumerate(chunks):
            cid = stable_id(str(pdf_path), str(idx))
            all_chunks.append({
                "id": cid,
                "text": ch,
                "metadata": {
                    "source": "pdf",
                    "file": pdf_path.name,
                    "path": str(pdf_path),
                    "chunk_index": idx,
                }
            })

        print(f"  -> {len(chunks)} chunks")

    return all_chunks

if __name__ == "__main__":
    print("PDF_DIR =", PDF_DIR)
    chunks = build_chunks_from_pdfs(PDF_DIR)
    print("Total chunks =", len(chunks))
    if chunks:
        upsert_chunks(chunks)
    else:
        print("Nothing to ingest.")
