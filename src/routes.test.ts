// Run with: TEST_MONGODB_URI=mongodb://localhost:27017 npm test
// Skipped when TEST_MONGODB_URI is not set. Uses a throw-away database and fakes the AI and S3
// steps (Gemini, picture storage), so no Google or AWS account is needed.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcrypt";
import express from "express";
import { MAX_DESIGNS_PER_HOUR } from "./schema";

const uri = process.env.TEST_MONGODB_URI;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ROOM = Buffer.from([...PNG_SIGNATURE, 1, 2, 3, 4]);
const RESULT = Buffer.from([...PNG_SIGNATURE, 9, 9, 9, 9]);

describe("renovation routes", { skip: !uri }, () => {
  let base = "";
  let close = () => {};
  let storage: typeof import("./storage").storage;
  let ai: typeof import("./ai").ai;
  let GenerationError: typeof import("./ai").GenerationError;
  const dbName = `renoviq_test_${Date.now()}`;
  const prompts: string[] = [];
  const saved = new Map<string, { data: Buffer; mimeType: string }>();
  const removed: string[] = [];
  let counter = 0;

  async function loginAs(username: string) {
    const password = "pw-" + username;
    await storage.createUser({
      firstName: "T",
      lastName: username,
      email: `${username}@example.com`,
      username,
      password: await bcrypt.hash(password, 4),
      confirmPassword: "",
      isVerified: true,
      verificationCode: null,
      verificationExpiry: null,
    });
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  // The create form: text fields plus an optional "photo" file part.
  const post = (cookie: string | null, fields: Record<string, string>, file?: { data: Buffer; name?: string; type?: string }) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    if (file) form.set("photo", new Blob([file.data], { type: file.type ?? "image/png" }), file.name ?? "room.png");
    return fetch(`${base}/api/renovations`, { method: "POST", headers: cookie ? { cookie } : {}, body: form });
  };
  const get = (cookie: string | null, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: cookie ? { cookie } : {} });
  const fields = { roomType: "Kitchen", style: "modern", description: "more light" };
  const room = { data: ROOM };

  before(async () => {
    Object.assign(process.env, {
      MONGODB_URI: uri,
      MONGODB_DB_NAME: dbName,
      SESSION_SECRET: "test",
      S3_BUCKET: "demo-bucket",
      AWS_REGION: "us-east-1",
      GEMINI_API_KEY: "k",
    });
    ({ storage } = await import("./storage"));
    ({ ai, GenerationError } = await import("./ai"));
    const { registerRoutes } = await import("./routes");

    ai.generate = async (_photo, prompt) => {
      prompts.push(prompt);
      return { data: RESULT, mimeType: "image/png" };
    };
    ai.store = async (userId, kind, image) => {
      const key = `${kind}/${userId}/${++counter}.png`;
      saved.set(key, image);
      return key;
    };
    ai.load = async (key) => {
      const image = saved.get(key);
      if (!image) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { body: Readable.from(image.data), contentType: image.mimeType, length: image.data.length };
    };
    ai.remove = async (keys) => {
      removed.push(...keys);
      keys.forEach((k) => saved.delete(k));
    };

    const app = express();
    app.use(express.json());
    const server = await registerRoutes(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  after(async () => {
    close();
    const { getDb, closeDatabaseConnection } = await import("./db");
    await getDb().dropDatabase();
    await closeDatabaseConnection();
  });

  it("401 without a session", async () => {
    assert.equal((await post(null, fields, room)).status, 401);
    assert.equal((await get(null, "/api/renovations/64b7f0f0f0f0f0f0f0f0f0f0/original")).status, 401);
  });

  it("creates the design, ignores client-set pictures and lists it with API addresses", async () => {
    const cookie = await loginAs("alice");
    const res = await post(cookie, { ...fields, generatedImage: "https://evil.example.com/x.png", userId: "someone-else" }, room);
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.originalImage, `/api/renovations/${created.id}/original`);
    assert.equal(created.generatedImage, `/api/renovations/${created.id}/generated`);
    assert.match(prompts.at(-1)!, /this kitchen in a modern interior design style/);
    assert.deepEqual([...saved.keys()].filter((k) => k.includes("/")).map((k) => k.split("/")[0]).slice(-2).sort(), ["generated", "originals"]);

    const list = await (await get(cookie, "/api/renovations")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
  });

  it("serves each picture to its owner only, with a private cache header", async () => {
    const cookie = await loginAs("bob");
    const created = await (await post(cookie, fields, room)).json();

    const original = await get(cookie, created.originalImage);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), "image/png");
    assert.match(original.headers.get("cache-control")!, /private/);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), ROOM);
    const generated = await get(cookie, created.generatedImage);
    assert.deepEqual(Buffer.from(await generated.arrayBuffer()), RESULT);

    const other = await loginAs("mallory");
    assert.equal((await get(other, created.originalImage)).status, 404, "another user cannot read it");
    assert.equal((await get(null, created.originalImage)).status, 401);
  });

  it("400 for a missing photo, a non-image, a missing room type or a photo over 5 MB, and stores nothing", async () => {
    const cookie = await loginAs("carol");
    const before = saved.size;
    const tryPost = async (f: Record<string, string>, file?: { data: Buffer; name?: string; type?: string }) => {
      const res = await post(cookie, f, file);
      return [res.status, (await res.json()).error];
    };
    assert.deepEqual(await tryPost(fields), [400, "Please attach a photo of your room."]);
    assert.deepEqual(await tryPost(fields, { data: Buffer.from("<html>hi</html>"), name: "room.jpg", type: "image/jpeg" }), [400, "The photo must be a JPG or PNG image."]);
    assert.equal((await tryPost({ style: "modern" }, room))[0], 400);
    assert.deepEqual(await tryPost(fields, { data: Buffer.concat([ROOM, Buffer.alloc(5 * 1024 * 1024)]) }), [400, "The photo must be 5 MB or smaller."]);
    assert.equal(saved.size, before);
    assert.equal((await (await get(cookie, "/api/renovations")).json()).length, 0);
  });

  it("passes AI errors through and saves nothing", async () => {
    const cookie = await loginAs("dave");
    const before = saved.size;
    const original = ai.generate;
    ai.generate = async () => {
      throw new GenerationError(429, "The AI service is busy right now. Please try again in a minute.");
    };
    const res = await post(cookie, fields, room);
    ai.generate = original;
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /busy/);
    assert.equal(saved.size, before);
    assert.equal((await (await get(cookie, "/api/renovations")).json()).length, 0);
  });

  it("503 when the AI or S3 settings are missing", async () => {
    const cookie = await loginAs("erin");
    const bucket = process.env.S3_BUCKET;
    delete process.env.S3_BUCKET;
    const res = await post(cookie, fields, room);
    process.env.S3_BUCKET = bucket;
    assert.equal(res.status, 503);
  });

  it("allows one design at a time per user", { timeout: 10_000 }, async () => {
    const cookie = await loginAs("frank");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = ai.generate;
    ai.generate = async (photo, prompt) => {
      await gate;
      return original(photo, prompt);
    };
    const first = post(cookie, fields, room);
    await new Promise((r) => setTimeout(r, 150)); // let the first request reach the AI step
    const second = await post(cookie, fields, room);
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /already being created/);
    release();
    assert.equal((await first).status, 201);
    ai.generate = original;
    assert.equal((await post(cookie, fields, room)).status, 201); // the slot is free again
  });

  it(`429 after ${MAX_DESIGNS_PER_HOUR} designs in an hour`, async () => {
    const cookie = await loginAs("grace");
    const me = await (await get(cookie, "/api/user")).json();
    for (let i = 0; i < MAX_DESIGNS_PER_HOUR; i++) {
      await storage.createRenovation({ userId: me.id, originalImage: "originals/x.png", generatedImage: "generated/x.png", roomType: "Kitchen" });
    }
    const res = await post(cookie, fields, room);
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, new RegExp(`${MAX_DESIGNS_PER_HOUR} designs per hour`));
  });

  it("deleting a design also removes both pictures from S3, and only for the owner", async () => {
    const cookie = await loginAs("heidi");
    const created = await (await post(cookie, fields, room)).json();
    const keys = (await storage.getRenovationKeys(created.id, (await (await get(cookie, "/api/user")).json()).id))!;

    const other = await loginAs("ivan");
    assert.equal((await get(other, `/api/renovations/${created.id}`, { method: "DELETE" })).status, 404);
    assert.deepEqual(removed.filter((k) => k === keys.originalImage), [], "a stranger's delete removes nothing");

    assert.equal((await get(cookie, `/api/renovations/${created.id}`, { method: "DELETE" })).status, 200);
    assert.ok(removed.includes(keys.originalImage) && removed.includes(keys.generatedImage));
    assert.equal((await get(cookie, created.originalImage)).status, 404);
  });

  it("keeps entries from before S3 (full URLs) working", async () => {
    const cookie = await loginAs("judy");
    const me = await (await get(cookie, "/api/user")).json();
    const old = await storage.createRenovation({ userId: me.id, originalImage: "https://old.example.com/a.jpg", generatedImage: "https://old.example.com/b.jpg", roomType: "Kitchen" });
    assert.equal(old.originalImage, "https://old.example.com/a.jpg");
    const res = await get(cookie, `/api/renovations/${old.id}/generated`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://old.example.com/b.jpg");
  });
});
