import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { generateOTP } from "./auth";
import { storage } from "./storage";
import {
  createRenovationSchema,
  insertUserSchema,
  MAX_DESIGNS_PER_HOUR,
  verifyOtpSchema,
} from "./schema";
import { z } from "zod";
import bcrypt from "bcrypt";
import { sendEmail } from "./email";
import { generateVerificationEmailContent } from "./email";
import passport from "passport";
import { ObjectId } from "mongodb";
import multer from "multer";
import { pipeline } from "node:stream";
import { ai, buildPrompt, GenerationError, MAX_PHOTO_BYTES, sniffImage } from "./ai";
import { config } from "./config";

// Users with a design being generated right now: one at a time each, so the hourly
// limit cannot be beaten by sending many requests at once.
// ponytail: in memory, fine for one server process; use a shared lock if you scale out.
const generating = new Set<string>();

// The room photo arrives as the "photo" part of a multipart form and is kept in memory (5 MB at most).
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }).single("photo");
const readUpload = (req: Parameters<typeof uploadPhoto>[0], res: Parameters<typeof uploadPhoto>[1]) =>
  new Promise<void>((resolve, reject) => uploadPhoto(req, res, (err) => (err ? reject(err) : resolve())));

export async function registerRoutes(app: Express): Promise<Server> {
  // CORS and body parsing are set up in index.ts. Passport and the session are set up here.
  setupAuth(app);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ──────────────── GOOGLE OAUTH ────────────────
  app.get(
    "/auth/google",
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
    })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: `${config.clientOrigin}/auth`,
      session: true,
    }),
    (req, res) => {
      // Successful authentication, redirect to client app or desired page
      res.redirect(`${config.clientOrigin}/studio`);
    }
  );

  // ──────────────── REGISTER ────────────────
  app.post("/api/register", async (req, res) => {
    try {
      const parseResult = insertUserSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.errors });
      }

      const { firstName, lastName, email, username, password } =
        parseResult.data;

      const existingEmail = await storage.getUserByEmail(email);
      if (existingEmail)
        return res.status(400).json({ error: "Email already registered" });

      const existingUsername = await storage.getUserByUsername(username);
      if (existingUsername)
        return res.status(400).json({ error: "Username already taken" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const otp = generateOTP();
      const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await storage.createUser({
        firstName,
        lastName,
        email,
        username,
        password: hashedPassword,
        isVerified: false,
        verificationCode: otp,
        verificationExpiry: expiry,
        confirmPassword: "",
      });

      const { htmlContent, plainTextContent } =
        generateVerificationEmailContent({
          firstName,
          lastName,
          otp,
        });

      await sendEmail(
        email,
        "Verify Your RenoviqAI Account - Action Required",
        plainTextContent,
        htmlContent
      );

      res.status(201).json({ message: "Verification code sent to your email" });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Failed to register user" });
    }
  });

  // ──────────────── OTP VERIFY ────────────────
  app.post("/api/verify-otp", async (req, res) => {
    try {
      const parseResult = verifyOtpSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.errors });
      }

      const { email, otp } = parseResult.data;
      const user = await storage.getUserByEmail(email);

      if (!user) return res.status(400).json({ error: "User not found" });
      if (user.isVerified)
        return res.status(400).json({ error: "User already verified" });
      if (user.verificationCode !== otp)
        return res.status(400).json({ error: "Invalid OTP" });
      if (!user.verificationExpiry || user.verificationExpiry < new Date()) {
        return res.status(400).json({ error: "OTP expired" });
      }

      await storage.verifyUser(user.id.toString());
      const updatedUser = await storage.getUserByEmail(email);
      if (!updatedUser) {
        return res
          .status(400)
          .json({ error: "Failed to retrieve updated user" });
      }

      req.login(updatedUser, (err) => {
        if (err)
          return res
            .status(500)
            .json({ error: "Login failed after verification" });

        return res.status(200).json({
          success: true,
          user: updatedUser,
        });
      });
    } catch (error) {
      console.error("OTP verification error:", error);
      return res.status(500).json({ error: "Failed to verify OTP" });
    }
  });

  // ──────────────── RESEND OTP ────────────────
  app.post("/api/resend-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }
      if (user.isVerified) {
        return res.status(400).json({ error: "User already verified" });
      }

      const otp = generateOTP();
      const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // console.log("Updating user verification code in DB for user:", user.id);
      await storage.updateUserVerificationCode(user.id.toString(), otp, expiry);
      // console.log("User verification code updated successfully");
      // console.log("Sending verification email to:", email);

      const { htmlContent, plainTextContent } =
        generateVerificationEmailContent({
          firstName: user.firstName,
          lastName: user.lastName,
          otp,
          isResend: true,
        });

      await sendEmail(
        email,
        "Your RenoviqAI Verification Code - Resend Request",
        plainTextContent,
        htmlContent
      );

      res
        .status(200)
        .json({ message: "Verification code resent to your email" });
    } catch (error) {
      console.error("Resend OTP error:", error);
      res.status(500).json({ error: "Failed to resend OTP" });
    }
  });

  // ──────────────── LOGIN ────────────────
  app.post("/api/login", (req, res, next) => {
    passport.authenticate(
      "local",
      (err: any, user: Express.User, info: { message: any }) => {
        if (err) return next(err);
        if (!user)
          return res
            .status(401)
            .json({ error: info?.message || "Unauthorized" });

        req.login(user, (err) => {
          if (err) return next(err);
          return res.status(200).json(user);
        });
      }
    )(req, res, next);
  });

  // ──────────────── LOGOUT ────────────────
  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  // ──────────────── CONTACT FORM ────────────────
  app.post("/api/contactForm", async (req, res) => {
    console.log("Received contact form submission:", req.body);
    try {
      const { fullName, email, company, message } = req.body;

      if (!fullName || !email || !message) {
        return res
          .status(400)
          .json({ error: "Full name, email, and message are required" });
      }

      // Save to database
      await storage.createContactFormEntry({
        fullName,
        email,
        company: company || "",
        message,
      });

      // Send email notification
      const emailSubject = "New Contact Form Submission";
      const emailText = `
        You have received a new contact form submission:

        Full Name: ${fullName}
        Email: ${email}
        Company: ${company || "N/A"}
        Message: ${message}
      `;

      // Replace with your email address
      const recipientEmail =
        process.env.CONTACT_FORM_RECEIVER_EMAIL || "your-email@example.com";

      await sendEmail(recipientEmail, emailSubject, emailText);

      res.status(200).json({ message: "Contact form submitted successfully" });
    } catch (error) {
      console.error("Contact form submission error:", error);
      res.status(500).json({ error: "Failed to submit contact form" });
    }
  });

  // ──────────────── GET LOGGED-IN USER ────────────────
  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    res.json(req.user);
  });

  // ──────────────── RENOVATION ROUTES ────────────────
  app.get("/api/renovations", async (req, res) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);
      const renovations = await storage.getRenovationsByUserId(req.user.id);
      res.json(renovations);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch renovations" });
    }
  });

  app.post("/api/renovations", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const userId = req.user.id;

    if (!ai.configured()) {
      return res.status(503).json({ error: "AI design is not set up on this server yet." });
    }
    if (generating.has(userId)) {
      return res.status(429).json({ error: "A design is already being created. Please wait for it to finish." });
    }

    generating.add(userId);
    try {
      try {
        await readUpload(req, res);
      } catch (error) {
        if (error instanceof multer.MulterError) {
          return res.status(400).json({
            error: error.code === "LIMIT_FILE_SIZE" ? "The photo must be 5 MB or smaller." : "The upload was not understood.",
          });
        }
        throw error;
      }

      const parsed = createRenovationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please attach a photo of your room." });
      }
      const mimeType = sniffImage(req.file.buffer);
      if (!mimeType) {
        return res.status(400).json({ error: "The photo must be a JPG or PNG image." });
      }
      const { roomType, style, description } = parsed.data;

      const since = new Date(Date.now() - 60 * 60 * 1000);
      if ((await storage.countRenovationsSince(userId, since)) >= MAX_DESIGNS_PER_HOUR) {
        return res.status(429).json({
          error: `You can create ${MAX_DESIGNS_PER_HOUR} designs per hour. Please try again later.`,
        });
      }

      const photo = { data: req.file.buffer, mimeType };
      const result = await ai.generate(photo, buildPrompt({ roomType, style, description }));
      // Nothing is stored unless the AI succeeded. If the database save fails after this, the two
      // pictures stay in S3 unused.
      const [originalImage, generatedImage] = await Promise.all([
        ai.store(userId, "originals", photo),
        ai.store(userId, "generated", result),
      ]);

      const renovation = await storage.createRenovation({
        userId,
        originalImage,
        generatedImage,
        roomType,
        style,
        description,
      });
      res.status(201).json(renovation);
    } catch (error) {
      if (error instanceof GenerationError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Create renovation error:", error);
      res.status(500).json({ error: "Failed to create the design. Please try again." });
    } finally {
      generating.delete(userId);
    }
  });

  // The pictures stay private in S3. Their owner loads them through here (the browser sends the session cookie).
  app.get("/api/renovations/:id/:kind(original|generated)", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    if (!ObjectId.isValid(req.params.id)) return res.sendStatus(400);
    try {
      const keys = await storage.getRenovationKeys(req.params.id, req.user.id);
      if (!keys) return res.sendStatus(404);
      const key = req.params.kind === "original" ? keys.originalImage : keys.generatedImage;
      if (/^https?:\/\//i.test(key)) return res.redirect(key); // entries from before S3

      const image = await ai.load(key);
      res.set({
        "Content-Type": image.contentType,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        ...(image.length !== undefined && { "Content-Length": String(image.length) }),
      });
      pipeline(image.body, res, (err) => {
        if (err) console.error("Streaming a picture failed:", err.message);
      });
    } catch (error: any) {
      if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return res.sendStatus(404);
      console.error("Load picture error:", error?.name, error?.message);
      res.sendStatus(502);
    }
  });

  app.delete("/api/renovations/:id", async (req, res) => {
    try {
      if (!req.isAuthenticated()) return res.sendStatus(401);

      const renovationId = req.params.id;
      if (!ObjectId.isValid(renovationId))
        return res.status(400).send("Invalid renovation ID");

      const keys = await storage.deleteRenovation(renovationId, req.user.id);
      if (!keys) return res.sendStatus(404);
      // The design is gone either way; a failed clean-up only leaves two unused files in S3.
      if (ai.configured()) {
        await ai.remove([keys.originalImage, keys.generatedImage]).catch((err) => console.error("S3 clean-up failed:", err?.message));
      }
      res.sendStatus(200);
    } catch (error) {
      res.status(500).json({ error: "Failed to delete renovation" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
