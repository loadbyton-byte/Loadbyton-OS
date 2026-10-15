import { config } from "../config.js";

/**
 * Optical character recognition for scanned documents and photographed paperwork, through Google Cloud Vision (REST, API key). Recognised text is only ever
 * a proposal: the same extraction rules, validation checks and human review apply as for a text layer, and the result is labelled as OCR so nobody mistakes it
 * for the document's own text. Document content leaves the installation only when the administrator has reviewed that data processing (OCR_DATA_PROCESSING_REVIEWED).
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface OcrResult { text: string; pages: number }
export interface OcrAdapter { name: string; recognise(buf: Buffer, mime: string): Promise<OcrResult> }
export const OCR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"];
export const OCR_MAX_BYTES = 8 * 1024 * 1024;

export function googleVisionOcr(cfg = config.ocr, fetchImpl: Fetch = fetch): OcrAdapter {
  const post = async (path: string, body: unknown) => {
    let res: Response;
    try { res = await fetchImpl(`${cfg.apiBase}/v1/${path}?key=${encodeURIComponent(cfg.apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) }); }
    catch { throw new Error("The OCR service could not be reached."); }       // the URL (with the key) is deliberately never put in an error
    if (res.status === 401 || res.status === 403) throw new Error("The OCR service refused the credential.");
    if (res.status === 429 || res.status >= 500) throw new Error(`The OCR service is unavailable (${res.status}).`);
    if (!res.ok) throw new Error(`The OCR service could not read this file (${res.status}).`);
    return (await res.json().catch(() => ({}))) as any;
  };
  return {
    name: "google-vision",
    async recognise(buf, mime) {
      const content = buf.toString("base64");
      if (mime === "application/pdf") {
        const out = await post("files:annotate", { requests: [{ inputConfig: { mimeType: "application/pdf", content }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], pages: Array.from({ length: cfg.maxPages }, (_, i) => i + 1) }] });
        const responses: any[] = out?.responses?.[0]?.responses ?? [];
        const err = out?.responses?.[0]?.error; if (err) throw new Error("The OCR service could not read this PDF.");
        return { text: responses.map((r) => r?.fullTextAnnotation?.text ?? "").filter(Boolean).join("\n").trim(), pages: responses.length };
      }
      const out = await post("images:annotate", { requests: [{ image: { content }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] });
      const r = out?.responses?.[0];
      if (r?.error) throw new Error("The OCR service could not read this image.");
      return { text: String(r?.fullTextAnnotation?.text ?? "").trim(), pages: 1 };
    },
  };
}
/**
 * OCR through a sidecar the installation runs itself (ops/ocr: Tesseract + poppler). The file is POSTed as-is to `/ocr`; the answer is {text,pages}.
 * Nothing leaves the installation, so no data-processing review flag is needed. Recognised text is a proposal, exactly as with any other OCR source.
 */
export function selfHostedOcr(cfg = config.ocr, fetchImpl: Fetch = fetch): OcrAdapter {
  return {
    name: "self-hosted",
    async recognise(buf, mime) {
      let res: Response;
      try { res = await fetchImpl(`${cfg.apiBase}/ocr`, { method: "POST", headers: { "content-type": mime }, body: buf as any, signal: AbortSignal.timeout(90_000) }); }
      catch { throw new Error("The OCR service could not be reached."); }
      if (res.status === 415) throw new Error("The OCR service does not read this file type.");
      if (res.status >= 500) throw new Error(`The OCR service is unavailable (${res.status}).`);
      if (!res.ok) throw new Error(`The OCR service could not read this file (${res.status}).`);
      const out: any = await res.json().catch(() => ({}));
      if (typeof out?.text !== "string") throw new Error("The OCR service returned an unexpected answer.");
      return { text: out.text.trim(), pages: Number(out.pages) || 1 };
    },
  };
}
export const defaultOcr = (): OcrAdapter | null => (config.ocr.provider === "google-vision" ? googleVisionOcr() : config.ocr.provider === "self-hosted" ? selfHostedOcr() : null);
