// Run with: TEST_MONGODB_URI=mongodb://localhost:27017 npm test
// Skipped when TEST_MONGODB_URI is not set. Uses a throw-away database and fakes the AI
// steps (photo download, Gemini, Firebase upload), so no Google account is needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import bcrypt from "bcrypt";
import express from "express";
import { MAX_DESIGNS_PER_HOUR } from "./schema";

const uri = process.env.TEST_MONGODB_URI;
const BUCKET = "demo-bucket";
const PHOTO = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/uploads%2F1_room.jpg?alt=media&token=t`;
const GENERATED = "https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/generated%2Fu%2Fx.png?alt=media&token=g";

describe("POST /api/renovations", { skip: !uri }, () => {
  let base = "";
  let close = () => {};
  let storage: typeof import("./storage").storage;
  let ai: typeof import("./ai").ai;
  let GenerationError: typeof import("./ai").GenerationError;
  const dbName = `renoviq_test_${Date.now()}`;
  const prompts: string[] = [];

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

  const post = (cookie: string | null, body: object) =>
    fetch(`${base}/api/renovations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const design = { originalImage: PHOTO, roomType: "Kitchen", style: "modern", description: "more light" };

  before(async () => {
    Object.assign(process.env, {
      MONGODB_URI: uri,
      MONGODB_DB_NAME: dbName,
      SESSION_SECRET: "test",
      FIREBASE_STORAGE_BUCKET: BUCKET,
      GEMINI_API_KEY: "k",
      FIREBASE_SERVICE_ACCOUNT: "{}",
    });
    ({ storage } = await import("./storage"));
    ({ ai, GenerationError } = await import("./ai"));
    const { registerRoutes } = await import("./routes");

    ai.fetchPhoto = async () => ({ data: Buffer.from("photo"), mimeType: "image/jpeg" });
    ai.generate = async (_photo, prompt) => {
      prompts.push(prompt);
      return { data: Buffer.from("result"), mimeType: "image/png" };
    };
    ai.store = async () => GENERATED;

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
    assert.equal((await post(null, design)).status, 401);
  });

  it("creates the design, ignores a client-supplied generatedImage and lists it", async () => {
    const cookie = await loginAs("alice");
    const res = await post(cookie, { ...design, generatedImage: "https://evil.example.com/x.png" });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.generatedImage, GENERATED);
    assert.equal(created.originalImage, PHOTO);
    assert.match(prompts.at(-1)!, /this kitchen in a modern interior design style/);

    const list = await (await fetch(`${base}/api/renovations`, { headers: { cookie } })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
  });

  it("400 for a photo that is not in this app's Firebase bucket", async () => {
    const cookie = await loginAs("bob");
    for (const originalImage of ["https://example.com/room.jpg", "http://169.254.169.254/latest/meta-data"]) {
      assert.equal((await post(cookie, { ...design, originalImage })).status, 400, originalImage);
    }
    const list = await (await fetch(`${base}/api/renovations`, { headers: { cookie } })).json();
    assert.equal(list.length, 0);
  });

  it("passes AI errors through and saves nothing", async () => {
    const cookie = await loginAs("carol");
    const original = ai.generate;
    ai.generate = async () => {
      throw new GenerationError(429, "The AI service is busy right now. Please try again in a minute.");
    };
    const res = await post(cookie, design);
    ai.generate = original;
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /busy/);
    const list = await (await fetch(`${base}/api/renovations`, { headers: { cookie } })).json();
    assert.equal(list.length, 0);
  });

  it("503 when the AI settings are missing", async () => {
    const cookie = await loginAs("dave");
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const res = await post(cookie, design);
    process.env.GEMINI_API_KEY = key;
    assert.equal(res.status, 503);
  });

  it("allows one design at a time per user", { timeout: 10_000 }, async () => {
    const cookie = await loginAs("erin");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = ai.generate;
    ai.generate = async (photo, prompt) => {
      await gate;
      return original(photo, prompt);
    };
    const first = post(cookie, design);
    await new Promise((r) => setTimeout(r, 150)); // let the first request reach the AI step
    const second = await post(cookie, design);
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /already being created/);
    release();
    assert.equal((await first).status, 201);
    ai.generate = original;
    assert.equal((await post(cookie, design)).status, 201); // the slot is free again
  });

  it(`429 after ${MAX_DESIGNS_PER_HOUR} designs in an hour`, async () => {
    const cookie = await loginAs("frank");
    const me = await (await fetch(`${base}/api/user`, { headers: { cookie } })).json();
    for (let i = 0; i < MAX_DESIGNS_PER_HOUR; i++) {
      await storage.createRenovation({ userId: me.id, originalImage: PHOTO, generatedImage: GENERATED, roomType: "Kitchen" });
    }
    const res = await post(cookie, design);
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, new RegExp(`${MAX_DESIGNS_PER_HOUR} designs per hour`));
  });
});
