// Run with: npm test
// No Google or AWS account needed: Gemini and S3 are faked
// with local HTTP servers that the real SDKs talk to.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ai, buildPrompt, GenerationError, sniffImage } from "./ai";

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

describe("sniffImage", () => {
  it("recognises JPEG and PNG by their first bytes", () => {
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  });
  it("refuses everything else, whatever the file is called", () => {
    assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
    assert.equal(sniffImage(Buffer.from("<html>not an image</html>")), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
    assert.equal(sniffImage(Buffer.alloc(0)), null);
  });
});

describe("buildPrompt", () => {
  it("names the room, style and quotes the notes", () => {
    const p = buildPrompt({ roomType: "Kitchen", style: "modern", description: "more light" });
    assert.match(p, /this kitchen in a modern interior design style/);
    assert.match(p, /"more light"/);
    assert.match(p, /layout, walls, windows/);
  });
  it("leaves out the notes when there are none", () => {
    assert.doesNotMatch(buildPrompt({ roomType: "Bedroom" }), /extra wishes/);
  });
});

// A tiny stand-in for S3 (path-style): PUT, GET and DELETE of objects. The real AWS SDK talks to it.
describe("S3 storage (fake S3)", () => {
  let s3: Awaited<ReturnType<typeof listen>>;
  const objects = new Map<string, { body: Buffer; type: string }>();
  const calls: string[] = [];
  let failPuts = false;

  before(async () => {
    s3 = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = decodeURIComponent((req.url || "").split("?")[0]);
        calls.push(`${req.method} ${path}`);
        if (req.method === "PUT") {
          if (failPuts) return res.writeHead(500).end();
          objects.set(path, { body: Buffer.concat(chunks), type: String(req.headers["content-type"]) });
          return res.writeHead(200, { etag: '"x"' }).end();
        }
        if (req.method === "DELETE") {
          objects.delete(path);
          return res.writeHead(204).end();
        }
        const obj = objects.get(path);
        if (!obj) {
          return res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
        }
        res.writeHead(200, { "content-type": obj.type, "content-length": obj.body.length }).end(obj.body);
      });
    });
    Object.assign(process.env, {
      S3_BUCKET: "demo-bucket",
      AWS_REGION: "us-east-1",
      S3_ENDPOINT: s3.url,
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
    });
  });
  after(() => s3.close());

  const png = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), mimeType: "image/png" };

  it("stores a picture under <kind>/<user>/<random>.<ext> with its content type", async () => {
    const key = await ai.store("u1", "originals", png);
    assert.match(key, /^originals\/u1\/[0-9a-f-]{36}\.png$/);
    const saved = objects.get(`/demo-bucket/${key}`);
    assert.ok(saved, "object was uploaded to the bucket path");
    assert.equal(saved.type, "image/png");
    assert.deepEqual(saved.body, png.data);
  });

  it("loads it back with its content type and length", async () => {
    const key = await ai.store("u1", "generated", png);
    const image = await ai.load(key);
    assert.equal(image.contentType, "image/png");
    assert.equal(image.length, png.data.length);
    const chunks: Buffer[] = [];
    for await (const c of image.body) chunks.push(c as Buffer);
    assert.deepEqual(Buffer.concat(chunks), png.data);
  });

  it("load reports a missing key as NoSuchKey", async () => {
    await assert.rejects(ai.load("generated/u1/nope.png"), (e: any) => e.name === "NoSuchKey");
  });

  it("removes keys and skips old full-URL entries", async () => {
    const key = await ai.store("u1", "originals", png);
    calls.length = 0;
    await ai.remove([key, "https://old.example.com/a.jpg", ""]);
    assert.deepEqual(calls, [`DELETE /demo-bucket/${key}`]);
    assert.equal(objects.has(`/demo-bucket/${key}`), false);
  });

  it("turns an S3 failure into a 502 the user can read", async () => {
    failPuts = true;
    await assert.rejects(ai.store("u1", "originals", png), (e: any) => e instanceof GenerationError && e.status === 502);
    failPuts = false;
  });
});

describe("generate (fake Gemini)", () => {
  let gemini: Awaited<ReturnType<typeof listen>>;
  let seen: { url?: string; key?: unknown; body?: any } = {};
  let mode: "image" | "empty" | "busy" | "broken" = "image";
  const png = Buffer.from("generated-image");

  before(async () => {
    gemini = await listen((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen = { url: req.url, key: req.headers["x-goog-api-key"], body: JSON.parse(raw || "{}") };
        const json = (status: number, body: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        if (mode === "busy") return json(429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } });
        if (mode === "broken") return json(500, { error: { code: 500, message: "boom", status: "INTERNAL" } });
        const content = mode === "image" ? [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] : [{ type: "text", text: "sorry" }];
        json(200, { id: "i1", status: "completed", steps: [{ type: "model_output", content }] });
      });
    });
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_BASE_URL = gemini.url;
    process.env.GEMINI_IMAGE_MODEL = "test-model";
  });
  after(() => gemini.close());

  const photo = { data: Buffer.from("room"), mimeType: "image/jpeg" };

  it("sends the prompt and photo and returns the image", async () => {
    mode = "image";
    const out = await ai.generate(photo, "make it nice");
    assert.deepEqual(out.data, png);
    assert.equal(out.mimeType, "image/png");
    assert.match(seen.url!, /\/interactions$/);
    assert.equal(seen.key, "test-key");
    assert.equal(seen.body.model, "test-model");
    const [text, image] = seen.body.input;
    assert.deepEqual(text, { type: "text", text: "make it nice" });
    assert.equal(image.type, "image");
    assert.equal(image.mime_type, "image/jpeg");
    assert.equal(Buffer.from(image.data, "base64").toString(), "room");
  });
  it("502 when the answer has no image", async () => {
    mode = "empty";
    await assert.rejects(ai.generate(photo, "x"), (e: any) => e instanceof GenerationError && e.status === 502);
  });
  it("429 when Google says the quota is used up", async () => {
    mode = "busy";
    await assert.rejects(ai.generate(photo, "x"), (e: any) => e instanceof GenerationError && e.status === 429);
  });
  it("502 when Google fails", async () => {
    mode = "broken";
    await assert.rejects(ai.generate(photo, "x"), (e: any) => e instanceof GenerationError && e.status === 502);
  });
});
