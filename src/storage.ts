import { User, InsertUserSchema, Renovation, InsertRenovation } from "./schema";
import session from "express-session";
import createMemoryStore from "memorystore";
import { connectToDatabase, getDb } from "./db";
import { ObjectId } from "mongodb";

const MemoryStore = createMemoryStore(session);

// What is stored for a design's two pictures: S3 keys (older entries may hold full URLs).
export type RenovationKeys = { originalImage: string; generatedImage: string };

// The browser gets API addresses; GET /api/renovations/:id/original|generated serves the picture to its owner.
const imageUrl = (id: string, kind: "original" | "generated", stored: string) =>
  !stored || /^https?:\/\//i.test(stored) ? stored : `/api/renovations/${id}/${kind}`;

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  createUser(user: InsertUserSchema & { 
    isVerified: boolean;
    verificationCode: string | null;
    verificationExpiry: Date | null;
    googleId?: string;
  }): Promise<User>;
  verifyUser(id: string): Promise<void>;
  updateUserGoogleId(id: string, googleId: string): Promise<void>;
  getRenovationsByUserId(userId: string): Promise<Renovation[]>;
  createRenovation(renovation: InsertRenovation): Promise<Renovation>;
  countRenovationsSince(userId: string, since: Date): Promise<number>;
  getRenovationKeys(id: string, userId: string): Promise<RenovationKeys | null>;
  deleteRenovation(id: string, userId: string): Promise<RenovationKeys | null>;
  createContactFormEntry(data: { fullName: string; email: string; company: string; message: string; }): Promise<void>;
  sessionStore: session.Store;
}

export class MongoStorage implements IStorage {
  sessionStore: session.Store;
  private dbReady: Promise<void>;

  constructor() {
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000,
    });
    this.dbReady = connectToDatabase().then(() => {});
  }

  private async getUsersCollection() {
    await this.dbReady;
    return getDb().collection("users");
  }

  private async getRenovationsCollection() {
    await this.dbReady;
    return getDb().collection("renovations");
  }

  private async getContactFormCollection() {
    await this.dbReady;
    return getDb().collection("contactForm");
  }

  private mapUser(doc: any): User {
    return {
      id: doc._id.toHexString(),
      username: doc.username,
      password: doc.password,
      firstName: doc.firstName,
      lastName: doc.lastName,
      email: doc.email,
      isVerified: doc.isVerified,
      verificationCode: doc.verificationCode,
      verificationExpiry: doc.verificationExpiry ? new Date(doc.verificationExpiry) : null,
      googleId: doc.googleId || null,
    };
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.getUser(id);
  }

  async getUser(id: string): Promise<User | undefined> {
    const users = await this.getUsersCollection();
    const doc = await users.findOne({ _id: new ObjectId(id) });
    if (!doc) return undefined;
    return this.mapUser(doc);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const users = await this.getUsersCollection();
    const doc = await users.findOne({ username });
    if (!doc) return undefined;
    return this.mapUser(doc);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const users = await this.getUsersCollection();
    const doc = await users.findOne({ email });
    if (!doc) return undefined;
    return this.mapUser(doc);
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const users = await this.getUsersCollection();
    const doc = await users.findOne({ googleId });
    if (!doc) return undefined;
    return this.mapUser(doc);
  }

  async createUser(user: InsertUserSchema & {
    isVerified: boolean;
    verificationCode: string | null;
    verificationExpiry: Date | null;
    googleId?: string;
  }): Promise<User> {
    const users = await this.getUsersCollection();
    const result = await users.insertOne(user);
    const insertedUser = await users.findOne({ _id: result.insertedId });
    if (!insertedUser) throw new Error("Failed to create user");
    return this.mapUser(insertedUser);
  }

  async updateUserGoogleId(id: string, googleId: string): Promise<void> {
    try {
      const users = await this.getUsersCollection();
      await users.updateOne(
        { _id: new ObjectId(id) },
        { $set: { googleId } }
      );
    } catch (error) {
      console.error("Error updating user googleId:", error);
      throw error;
    }
  }

  async verifyUser(id: string): Promise<void> {
    try {
      const users = await this.getUsersCollection();
      await users.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isVerified: true, verificationCode: null, verificationExpiry: null } }
    );
    }
    catch (error) {
      console.error("Error verifying user:", error);
      console.log("Error Verifying");
      throw error;
    }
  }

  private mapRenovation(doc: any): Renovation {
    return {
      id: doc._id.toHexString(),
      userId: String(doc.userId),
      originalImage: imageUrl(doc._id.toHexString(), "original", String(doc.originalImage || "")),
      generatedImage: imageUrl(doc._id.toHexString(), "generated", String(doc.generatedImage || "")),
      roomType: String(doc.roomType || ""),
      style: doc.style || null,
      description: doc.description || null,
      createdAt: doc.createdAt ? new Date(doc.createdAt) : null,
    };
  }

  async getRenovationsByUserId(userId: string): Promise<Renovation[]> {
    const renovations = await this.getRenovationsCollection();
    const docs = await renovations.find({ userId }).sort({ createdAt: -1 }).toArray();
    return docs.map((doc) => this.mapRenovation(doc));
  }

  async createRenovation(renovation: InsertRenovation): Promise<Renovation> {
    const renovations = await this.getRenovationsCollection();
    const result = await renovations.insertOne({
      userId: renovation.userId,
      originalImage: renovation.originalImage,
      generatedImage: renovation.generatedImage,
      roomType: renovation.roomType,
      style: renovation.style ?? null,
      description: renovation.description ?? null,
      createdAt: new Date(),
    });
    const insertedRenovation = await renovations.findOne({ _id: result.insertedId });
    if (!insertedRenovation) throw new Error("Failed to create renovation");
    return this.mapRenovation(insertedRenovation);
  }

  async countRenovationsSince(userId: string, since: Date): Promise<number> {
    const renovations = await this.getRenovationsCollection();
    return renovations.countDocuments({ userId, createdAt: { $gte: since } });
  }

  // Only the owner can read a design's picture keys.
  async getRenovationKeys(id: string, userId: string): Promise<RenovationKeys | null> {
    const renovations = await this.getRenovationsCollection();
    const doc = await renovations.findOne({ _id: new ObjectId(id), userId });
    return doc ? { originalImage: String(doc.originalImage || ""), generatedImage: String(doc.generatedImage || "") } : null;
  }

  // Only the owner can delete a renovation. Returns its picture keys, or null when nothing matched.
  async deleteRenovation(id: string, userId: string): Promise<RenovationKeys | null> {
    const renovations = await this.getRenovationsCollection();
    const doc = await renovations.findOneAndDelete({ _id: new ObjectId(id), userId });
    return doc ? { originalImage: String(doc.originalImage || ""), generatedImage: String(doc.generatedImage || "") } : null;
  }

  async createContactFormEntry(data: { fullName: string; email: string; company: string; message: string; }): Promise<void> {
    try {
      const contactForm = await this.getContactFormCollection();
      await contactForm.insertOne({
        fullName: data.fullName,
        email: data.email,
        company: data.company,
        message: data.message,
        createdAt: new Date(),
      });
      console.log("Contact form entry saved to MongoDB");
    } catch (error) {
      console.error("Error saving contact form entry:", error);
      throw error;
    }
  }
  async updateUserVerificationCode(id: string, code: string, expiry: Date): Promise<void> {
    try {
      const users = await this.getUsersCollection();
      await users.updateOne(
        { _id: new ObjectId(id) },
        { $set: { verificationCode: code, verificationExpiry: expiry } }
      );
    } catch (error) {
      console.error("Error updating user verification code:", error);
      throw error;
    }
  }
}

export const storage = new MongoStorage();
