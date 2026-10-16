import passport from "passport";
import { storage } from "./storage"; // Adjust path if needed
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import dotenv from "dotenv";

dotenv.config();

// 🔐 How to store user in session
passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

// 🔐 How to retrieve user from session
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await storage.getUserById(id) as any;
    if (user == null) {
      return done(null, false);
    }
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL!,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Find existing user by Google ID or email
        let user = await storage.getUserByGoogleId(profile.id);
        if (!user) {
          // If no user with Google ID, try by email
          const email = profile.emails && profile.emails[0]?.value;
          if (email) {
            user = await storage.getUserByEmail(email);
          }
        }

        if (!user) {
          // Create new user if none found
          const email = profile.emails && profile.emails[0]?.value;
          const firstName = profile.name?.givenName || "";
          const lastName = profile.name?.familyName || "";
          const username = email ? email.split("@")[0] : profile.id;

          user = await storage.createUser({
            firstName,
            lastName,
            email: email || "",
            username,
            password: "", // No password for Google OAuth users
            isVerified: true,
            googleId: profile.id,
            verificationCode: "",
            verificationExpiry: null,
            confirmPassword: "",
          });
        } else if (!user.googleId) {
          // Update existing user with Google ID if missing
          await storage.updateUserGoogleId(user.id.toString(), profile.id);
        }

        done(null, user);
      } catch (error) {
        done(error as Error);
      }
    }
  )
);
