import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import "./config";

// AI redesign: ask Gemini for a redesigned version of a room photo and keep the pictures in S3.
// Everything the routes need is on the `ai` object at the bottom so tests can swap single functions.

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // same limit as the upload form
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
  bucket: process.env.S3_BUCKET,
  region: process.env.AWS_REGION,
  // Only for S3-compatible servers (MinIO, tests). Leave unset for AWS.
  s3Endpoint: process.env.S3_ENDPOINT,
});

function configured(): boolean {
  const e = env();
  return Boolean(e.geminiKey && e.bucket && e.region);
}

// The type comes from the file's first bytes, never from what the browser says it is.
export function sniffImage(data: Buffer): "image/jpeg" | "image/png" | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  return null;
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
    const interaction = await client.interactions.create(
      {
        model: e.model,
        input: [
          { type: "text", text: prompt },
          { type: "image", mime_type: photo.mimeType as "image/jpeg" | "image/png", data: photo.data.toString("base64") },
        ],
      },
      // No automatic retries: the SDK waits as long as Google's Retry-After asks (up to a minute) before each one,
      // so a refused request (quota 0) kept the user waiting a minute for the same error. The user can just try again.
      { maxRetries: 0 },
    );
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

// Credentials come from the usual AWS places: the instance role on EC2, or AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY in the environment.
let s3: S3Client | undefined;
function client(): S3Client {
  const e = env();
  return (s3 ??= new S3Client({
    region: e.region,
    ...(e.s3Endpoint && { endpoint: e.s3Endpoint, forcePathStyle: true }),
  }));
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Saves a picture and returns its S3 key: <kind>/<user id>/<random>.<ext>
async function store(userId: string, kind: "originals" | "generated", image: Photo): Promise<string> {
  const key = `${kind}/${userId}/${randomUUID()}.${EXTENSIONS[image.mimeType] ?? "bin"}`;
  try {
    await client().send(
      new PutObjectCommand({ Bucket: env().bucket, Key: key, Body: image.data, ContentType: image.mimeType }),
    );
  } catch (err: any) {
    console.error("S3 upload failed:", err?.name, err?.message);
    throw new GenerationError(502, "The design could not be saved. Please try again.");
  }
  return key;
}

async function load(key: string): Promise<{ body: Readable; contentType: string; length?: number }> {
  const out = await client().send(new GetObjectCommand({ Bucket: env().bucket, Key: key }));
  return {
    body: out.Body as Readable,
    contentType: out.ContentType || "application/octet-stream",
    length: out.ContentLength,
  };
}

// Entries from before S3 hold full URLs instead of keys; those are not ours to delete.
async function remove(keys: string[]): Promise<void> {
  await Promise.all(
    keys
      .filter((key) => key && !/^https?:\/\//i.test(key))
      .map((key) => client().send(new DeleteObjectCommand({ Bucket: env().bucket, Key: key }))),
  );
}

export const ai = { configured, generate, store, load, remove };
