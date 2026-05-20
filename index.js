import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import cors from 'cors';
import db from "./firebase.js";  // import db
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({ storage: multer.memoryStorage() });
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY in environment');
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000);
}

// 1) Transcription endpoint
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    // ✅ Wrap Buffer into a Blob
    const audioBlob = new Blob([req.file.buffer], { type: 'audio/webm' });

    const form = new FormData();
    form.append('file', audioBlob, 'audio.webm');
    form.append('model', 'whisper-1');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form
    });

    const data = await r.json();
    res.json({ text: data.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2) Assistant endpoint
// 2) Assistant endpoint (streaming)
app.post("/api/assistant", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",  // fastest
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = r.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      chunk.split("\n").forEach((line) => {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              res.write(token); // flush token immediately
            }
          } catch { }
        }
      });
    }

    res.end();
  } catch (err) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/assistant", async (req, res) => {
  try {
    const { prompt } = req.body;

    const r = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
      }
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true,
      });

      let lines = buffer.split("\n");

      buffer = lines.pop(); // keep incomplete chunk

      for (let line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.replace("data: ", "").trim();

        if (data === "[DONE]") {
          res.end();
          return;
        }

        try {
          const parsed = JSON.parse(data);

          const token =
            parsed.choices?.[0]?.delta?.content;

          if (token) {
            res.write(token);
          }
        } catch (err) {
          console.log("Parse error:", err);
        }
      }
    }

    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message,
    });
  }
});



// Register User
app.post("/api/register", async (req, res) => {
  try {
    const { email, phone, firstname, lastname, password, timer } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const userRef = db.ref("users").child(email.replace(/\./g, "_")); // Firebase keys can't have '.'

    const snapshot = await userRef.get();
    if (snapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    const userData = {
      email,
      phone,
      firstname,
      lastname,
      password, // ⚠️ in real app hash this before saving
      timer, // 60, 90, 120
      disabled: false,
      isAdmin: false,
      createdAt: Date.now(),
    };

    await userRef.set(userData);
    res.json({ message: "User registered successfully", user: userData });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/register", async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password, techStack, experience, projects, role, codingLanguages } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const userRef = db.ref("users").child(email.replace(/\./g, "_")); // Firebase keys can't have '.'

    const snapshot = await userRef.get();
    if (snapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    let timer = 2; // default 1 hour

    const userData = {
      firstName,
      lastName,
      email,
      phone,
      password,
      techStack,
      experience,
      projects,
      role,
      codingLanguages,
      timer,
      disabled: false,
      isAdmin: false,
      createdAt: Date.now(),
    };

    await userRef.set(userData);
    res.json({ message: "User registered successfully", user: userData });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/logout", async (req, res) => {
  try {
    const { email, remaining } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "Email required"
      });
    }

    const userRef = db
      .ref("users")
      .child(email.replace(/\./g, "_"));

    const snapshot = await userRef.get();

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    // convert remaining seconds → minutes
    const remainingMinutes =
      Math.max(
        Math.ceil((remaining || 0) / 60),
        0
      ) - 1;

    await userRef.update({
      timer: remainingMinutes,
      expiryTime: null,
      disabled: remainingMinutes <= 0
    });

    res.json({
      success: true,
      message: "Logout successful",
      remainingMinutes
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

// Login User
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Login attempt for:", email, password);
    const userRef = db.ref("users").child(email.replace(/\./g, "_"));
    const snapshot = await userRef.get();

    if (!snapshot.exists()) return res.status(400).json({ error: "User not found" });

    const user = snapshot.val();

    if (user.disabled) return res.status(403).json({ error: "User is disabled" });
    if (user.password !== password) return res.status(401).json({ error: "Invalid credentials" });

    // Set expiry
    const expiryTime = Date.now() + user.timer * 60 * 1000;
    await userRef.update({ expiryTime });

    res.json({
      message: "Login successful",
      name: `${user.firstname} ${user.lastname}`,
      timer: user.timer,
      isAdmin: user.isAdmin || false,
      expiryTime,
      ...user
    });
    // Auto disable after timer expires
    setTimeout(async () => {
      if (user.isAdmin == false || !user.isAdmin)
        await userRef.update({ disabled: true });
      console.log(`User ${email} disabled after ${user.timer} mins`);
    }, user.timer * 60 * 1000);

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:os", (req, res) => {
  try {
    const { os } = req.params;

    let filePath = "";
    let fileName = "";

    if (os === "windows") {
      filePath = path.join(__dirname, "files", "overlay-ai.exe");
      fileName = "overlay-ai.exe";
    }
    else if (os === "mac") {
      filePath = path.join(__dirname, "files", "myapp.dmg");
      fileName = "myapp.dmg";
    }
    else {
      return res.status(400).json({
        success: false,
        message: "Invalid OS",
      });
    }

    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Download error:", err);

        return res.status(500).json({
          success: false,
          message: "Download failed",
        });
      }
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Get all users
app.get("/api/users", async (req, res) => {
  try {
    const snapshot = await db.ref("users").get();
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "No users found" });
    }

    const users = snapshot.val();

    // Convert object to array with email as id
    const userList = Object.keys(users).map((key) => ({
      id: key.replace(/_/g, "."),
      ...users[key],
    }));

    res.json({ users: userList });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Disable a user manually (admin action)
app.post("/api/disable-user", async (req, res) => {
  try {
    const { email, disabled } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    console.log("Disable user request for:", email);
    // Firebase keys can't have `.`, so replace with `_`
    const userRef = db.ref("users").child(email.replace(/\./g, "_"));
    const snapshot = await userRef.get();

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    await userRef.update({ disabled: disabled });

    res.json({ success: true, message: `User ${email} status changed successfully` });
  } catch (err) {
    console.error("Disable user error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/send-otp",
  async (req, res) => {

    try {

      const { email, name } =
        req.body;


      const otp =
        Math.floor(
          100000 +
          Math.random() * 900000
        ).toString();


      // save otp in firebase

      await db
        .ref("otp")
        .child(
          email.replace(/\./g, "_")
        )
        .set({

          otp,

          createdAt:
            Date.now()

        });



      await resend.emails.send({

        from:
          "Krack-AI OTP <validate@verify.krack-ai.com>",

        to:
          email,

        subject:
          "Your OTP Verification",

        html: `<div style="font-family: Arial, sans-serif; background:#f4f4f4; padding:40px;">
  <div style="
      max-width:500px;
      margin:auto;
      background:white;
      padding:30px;
      border-radius:12px;
      box-shadow:0 4px 12px rgba(0,0,0,0.1);
      text-align:center;
  ">
    
    <h2 style="color:#333;">
      Verify Your Email
    </h2>

    <p style="color:#666; font-size:16px;">
      Use the OTP below to complete your verification.
    </p>

    <div style="
        font-size:32px;
        font-weight:bold;
        letter-spacing:8px;
        background:#f8f9fa;
        padding:20px;
        border-radius:10px;
        margin:20px 0;
        color:#ff5f6d;
    ">
      ${otp}
    </div>

    <p style="color:#888;">
      This OTP will expire in <strong>5 minutes</strong>.
    </p>

    <p style="font-size:14px;color:#999;margin-top:25px;">
      If you didn't request this verification, ignore this email.
    </p>

    <hr style="border:none;border-top:1px solid #eee;margin:25px 0;">

    <p style="font-size:12px;color:#aaa;">
      © ${new Date().getFullYear()} Your App Name
    </p>

  </div>
</div>
`

      });


      res.json({

        success: true,

        message:
          "OTP sent"

      });


    } catch (err) {

      console.log(err);

      res.status(500).json({

        success: false,

        message:
          err.message

      });

    }

  });

app.post("/verify-otp", async (req, res) => {

  try {

    const { email, otp } =
      req.body;

    if (
      !email ||
      !otp
    ) {

      return res.status(400).json({
        success: false,
        message: "Email & OTP required"
      });

    }


    const otpRef =
      db
        .ref("otp")
        .child(
          email.replace(/\./g, "_")
        );


    const snapshot =
      await otpRef.get();


    if (
      !snapshot.exists()
    ) {

      return res.status(400).json({
        success: false,
        message: "OTP not found"
      });

    }


    const savedOtp =
      snapshot.val();


    // expiry check (5 mins)

    const expired =
      Date.now() -
      savedOtp.createdAt >
      5 * 60 * 1000;


    if (expired) {

      await otpRef.remove();

      return res.status(400).json({
        success: false,
        message: "OTP expired"
      });

    }


    if (
      savedOtp.otp !== otp
    ) {

      return res.status(400).json({
        success: false,
        message: "Invalid OTP"
      });

    }


    // delete OTP after success

    await otpRef.remove();


    res.json({
      success: true,
      message:
        "OTP verified"
    });

  }
  catch (err) {

    console.log(err);

    res.status(500).json({
      success: false,
      message:
        err.message
    });

  }

});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
