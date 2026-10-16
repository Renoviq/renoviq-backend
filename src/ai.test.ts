// Run with: npm test
// No Google, Firebase or database account needed: Gemini and the photo host are faked
// with local HTTP servers. Firebase upload (ai.store) is the one part not covered here.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ai, buildPrompt, downloadUrl, GenerationError, isOwnPhotoUrl } from "./ai";

const BUCKET = "demo-bucket";

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

describe("isOwnPhotoUrl", () => {
  const ok = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/uploads%2F1_room.jpg?alt=media&token=t`;
  it("accepts an upload from this bucket", () => assert.equal(isOwnPhotoUrl(ok, BUCKET), true));
  it("rejects other hosts, buckets, folders, http and junk", () => {
    for (const bad of [
      "https://evil.example.com/v0/b/demo-bucket/o/uploads%2Fa.jpg",
      "https://firebasestorage.googleapis.com/v0/b/other/o/uploads%2Fa.jpg",
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/generated%2Fa.png`,
      `http://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/uploads%2Fa.jpg`,
      "http://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      assert.equal(isOwnPhotoUrl(bad, BUCKET), false, bad);
    }
  });
  it("rejects everything when no bucket is configured", () => assert.equal(isOwnPhotoUrl(ok, ""), false));
});

describe("buildPrompt and downloadUrl", () => {
  it("names the room, style and quotes the notes", () => {
    const p = buildPrompt({ roomType: "Kitchen", style: "modern", description: "more light" });
    assert.match(p, /this kitchen in a modern interior design style/);
    assert.match(p, /"more light"/);
    assert.match(p, /layout, walls, windows/);
  });
  it("leaves out the notes when there are none", () => {
    assert.doesNotMatch(buildPrompt({ roomType: "Bedroom" }), /extra wishes/);
  });
  it("builds a Firebase download URL with an encoded path", () => {
    assert.equal(
      downloadUrl("b", "generated/u1/x.png", "tok"),
      "https://firebasestorage.googleapis.com/v0/b/b/o/generated%2Fu1%2Fx.png?alt=media&token=tok",
    );
  });
});

describe("fetchPhoto", () => {
  let host: Awaited<ReturnType<typeof listen>>;
  before(async () => {
    host = await listen((req, res) => {
      if (req.url === "/ok") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("png-bytes"));
      if (req.url === "/html") return res.writeHead(200, { "content-type": "text/html" }).end("<p>no</p>");
      if (req.url === "/big") return res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.alloc(5 * 1024 * 1024 + 1));
      if (req.url === "/redirect") return res.writeHead(302, { location: "/ok" }).end();
      res.writeHead(404).end();
    });
  });
  after(() => host.close());

  const failsWith400 = (path: string) =>
    assert.rejects(ai.fetchPhoto(host.url + path), (e: unknown) => e instanceof GenerationError && e.status === 400);

  it("returns the bytes and the image type", async () => {
    const photo = await ai.fetchPhoto(host.url + "/ok");
    assert.equal(photo.mimeType, "image/png");
    assert.equal(photo.data.toString(), "png-bytes");
  });
  it("refuses non-images, big files, redirects and missing files", async () => {
    await failsWith400("/html");
    await failsWith400("/big");
    await failsWith400("/redirect");
    await failsWith400("/missing");
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
