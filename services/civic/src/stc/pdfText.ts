/** pdf.js (Apache-2.0) text extraction: pages -> lines (grouped by y, ordered by x). */
export async function pdfPagesToLines(bytes: Uint8Array): Promise<string[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 }).promise;
  const pages: string[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const lines = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5]!);
      const key = [...lines.keys()].find((k) => Math.abs(k - y) < 3) ?? y;
      lines.set(key, [...(lines.get(key) ?? []), { x: it.transform[4]!, s: it.str }]);
    }
    pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => items.sort((a, b) => a.x - b.x).map((t) => t.s).join(' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/\s+\./g, '.').trim()));
  }
  return pages;
}
