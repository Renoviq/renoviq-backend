import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser } from "./schema";
import { z } from "zod";
import { config } from "./config";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

async function hashPassword(password: string) {
  return await bcrypt.hash(password, 10);
}

// Compare password using bcrypt
async function comparePasswords(supplied: string, stored: string) {
  return await bcrypt.compare(supplied, stored);
}

// Function to generate a 6-digit OTP
export function generateOTP() {
  const otp = crypto.randomInt(100000, 1000000); // generates a 6-digit number
  return otp.toString();
}

export function setupAuth(app: Express) {
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      const user = await storage.getUserByUsername(username);
      if (!user || !(await comparePasswords(password, user.password))) {
        return done(null, false);
      } else if (!user.isVerified) {
        return done(null, false, { message: "Please verify your email first" });
      } else {
        return done(null, user);
      }
    })
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error as Error);
    }
  });
}

dotenv.config();

export const insertUserSchema = z.object({
  username: z.string(),
  password: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  confirmPassword: z.string(),
});

export const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});
