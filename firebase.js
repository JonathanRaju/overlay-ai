import admin from "firebase-admin";
import dotenv from 'dotenv';


dotenv.config();

// You need service account JSON file from Firebase console
// import fs from "fs";

// const serviceAccount = JSON.parse(
//   fs.readFileSync("./serviceAccountKey.json", "utf8")
// );
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://interview-screening-ba646-default-rtdb.firebaseio.com"
});

const db = admin.database();
export default db;
