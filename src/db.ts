import { MongoClient, Db } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB_NAME || "renoviqai";

let client: MongoClient;
let db: Db;

export async function connectToDatabase() {
  if (db) {
    return db;
  }
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  console.log("Connected to MongoDB:", uri, "Database:", dbName);
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error("Database not connected. Call connectToDatabase first.");
  }
  return db;
}

export async function closeDatabaseConnection() {
  if (client) {
    await client.close();
  }
}
