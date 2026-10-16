import { z } from "zod";

// Types and zod schemas for the data stored in MongoDB (see server/storage.ts).
// Ids are ObjectId hex strings.

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  username: string;
  password: string;
  isVerified: boolean | null;
  verificationCode: string | null;
  verificationExpiry: Date | null;
  googleId: string | null;
  // Picture URLs read by the user menu. Nothing sets them yet.
  profileImage?: string;
  avatar?: string;
};

export type Renovation = {
  id: string;
  userId: string;
  originalImage: string;
  generatedImage: string;
  roomType: string;
  style: string | null;
  description: string | null;
  createdAt: Date | null;
};

export const baseUserSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  username: z.string(),
  password: z.string(),
});

export const insertUserSchema = baseUserSchema
  .extend({
    confirmPassword: z.string(),
    googleId: z.string().optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

// Body of POST /api/renovations. The browser uploads the photo to Firebase Storage
// and sends only its URL; the server checks that URL, asks the AI for the redesign and
// stores the result, so the client cannot set generatedImage itself.
export const createRenovationSchema = z.object({
  originalImage: httpUrl,
  roomType: z.string().trim().min(1).max(50),
  style: z.string().trim().max(50).optional(),
  description: z.string().trim().max(2000).optional(),
});

// One user can create this many designs per rolling hour (each one costs an AI call).
export const MAX_DESIGNS_PER_HOUR = 10;

export type InsertUserSchema = z.infer<typeof insertUserSchema>;
export type InsertRenovation = z.infer<typeof createRenovationSchema> & {
  userId: string;
  generatedImage: string;
};
export type VerifyOtp = z.infer<typeof verifyOtpSchema>;
