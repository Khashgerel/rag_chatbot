export function chunkText(text: string, chunkSize = 900, overlap = 150) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];

  let i = 0;
  while (i < clean.length) {
    const part = clean.slice(i, i + chunkSize).trim();
    if (part.length > 60) chunks.push(part);
    i += chunkSize - overlap;
  }

  return chunks;
}
