import dotenv from "dotenv";

// Loaded here as well because ES module imports run before the code in index.ts.
dotenv.config();

const isProd = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT) || 3000,
  // Where the browser app is served from. Used for CORS and the redirect after Google sign-in.
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  // Session cookies need HTTPS when secure. Set COOKIE_SECURE=false to run the production build over plain http.
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
};
