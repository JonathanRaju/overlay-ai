import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import cors from 'cors';
import db from "./firebase.js";  // import db

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({ storage: multer.memoryStorage() });
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY in environment');
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

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

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
          } catch {}
        }
      });
    }

    res.end();
  } catch (err) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message });
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
    });
    // Auto disable after timer expires
    setTimeout(async () => {
      if(user.isAdmin == false || !user.isAdmin)
      await userRef.update({ disabled: true });
      console.log(`User ${email} disabled after ${user.timer} mins`);
    }, user.timer * 60 * 1000);

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
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





const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
