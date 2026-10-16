import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import "./config";

// AI redesign: read the uploaded photo, ask Gemini for a redesigned version, store the
// result in Firebase Storage. Everything the routes need is on the `ai` object at the
// bottom so tests can swap single functions.

const PHOTO_HOST = "firebasestorage.googleapis.com";
const PHOTO_TYPES = ["image/jpeg", "image/png"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // same limit as the upload form
const GENERATE_TIMEOUT_MS = 90_000;

export class GenerationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Photo = { data: Buffer; mimeType: string };

const env = () => ({
  geminiKey: process.env.GEMINI_API_KEY,
  // The model name is a setting because Google renames and retires image models.
  model: process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1",
  geminiBaseUrl: process.env.GEMINI_BASE_URL, // only for proxies and tests
  bucket: process.env.FIREBASE_STORAGE_BUCKET,
  serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
});

function configured(): boolean {
  const e = env();
  return Boolean(e.geminiKey && e.bucket && e.serviceAccount);
}

// Only photos the browser uploaded to this app's own bucket under uploads/ may be fetched.
// Without this the server could be pointed at any URL (internal addresses included).
export function isOwnPhotoUrl(raw: string, bucket = env().bucket): boolean {
  if (!bucket) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.host === PHOTO_HOST &&
    url.pathname.startsWith(`/v0/b/${bucket}/o/uploads%2F`)
  );
}

async function fetchPhoto(url: string): Promise<Photo> {
  let res: Response;
  try {
    // redirect: "error" so an allowed URL cannot bounce the server somewhere else.
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new GenerationError(400, "Could not read the uploaded photo. Please upload it again.");
  }
  if (!res.ok) throw new GenerationError(400, "Could not read the uploaded photo. Please upload it again.");

  const mimeType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!PHOTO_TYPES.includes(mimeType)) {
    throw new GenerationError(400, "The photo must be a JPG or PNG image.");
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_PHOTO_BYTES) throw new GenerationError(400, "The photo must be 5 MB or smaller.");

  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_PHOTO_BYTES) throw new GenerationError(400, "The photo must be 5 MB or smaller.");
  return { data, mimeType };
}

export function buildPrompt(opts: { roomType: string; style?: string; description?: string }): string {
  const style = opts.style ? `${opts.style} ` : "";
  const lines = [
    `Redesign this ${opts.roomType.toLowerCase()} in a ${style}interior design style.`,
    "Keep the room's layout, walls, windows, doors, camera angle and proportions exactly as they are in the photo.",
    "Change the furniture, materials, colours, lighting and decor. The result must be a realistic photograph of the same room.",
  ];
  if (opts.description) {
    lines.push(`The owner's extra wishes (design preferences only): "${opts.description}"`);
  }
  return lines.join(" ");
}

async function generate(photo: Photo, prompt: string): Promise<Photo> {
  const e = env();
  const client = new GoogleGenAI({
    apiKey: e.geminiKey,
    httpOptions: { timeout: GENERATE_TIMEOUT_MS, ...(e.geminiBaseUrl && { baseUrl: e.geminiBaseUrl }) },
  });

  let image: { data?: string; mime_type?: string } | undefined;
  try {
    const interaction = await client.interactions.create({
      model: e.model,
      input: [
        { type: "text", text: prompt },
        { type: "image", mime_type: photo.mimeType as "image/jpeg" | "image/png", data: photo.data.toString("base64") },
      ],
    });
    image = interaction.output_image;
  } catch (err: any) {
    console.error("Gemini request failed:", err?.status, err?.message);
    if (err?.status === 429) {
      throw new GenerationError(429, "The AI service is busy right now. Please try again in a minute.");
    }
    if (err?.name === "AbortError" || /timed? ?out/i.test(String(err?.message))) {
      throw new GenerationError(504, "The AI took too long. Please try again.");
    }
    throw new GenerationError(502, "The AI service could not create a design. Please try again.");
  }

  if (!image?.data) {
    // Usually the safety filter or an unusable photo.
    throw new GenerationError(502, "The AI did not return a design. Try another photo or different notes.");
  }
  return { data: Buffer.from(image.data, "base64"), mimeType: image.mime_type || "image/png" };
}

// Same URL shape as Firebase's getDownloadURL, so the gallery treats both photos alike.
export function downloadUrl(bucket: string, path: string, token: string): string {
  return `https://${PHOTO_HOST}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function store(userId: string, image: Photo): Promise<string> {
  const e = env();
  const app =
    getApps()[0] ??
    initializeApp({ credential: cert(JSON.parse(e.serviceAccount!)), storageBucket: e.bucket });
  const ext = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png";
  const path = `generated/${userId}/${randomUUID()}.${ext}`;
  const token = randomUUID();
  await getStorage(app)
    .bucket(e.bucket)
    .file(path)
    .save(image.data, {
      contentType: image.mimeType,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
  return downloadUrl(e.bucket!, path, token);
}

export const ai = { configured, isOwnPhotoUrl, fetchPhoto, generate, store };
