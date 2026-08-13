import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import cors from 'cors';
import db from "./firebase.js";  // import db
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import { Cashfree, CFEnvironment } from "cashfree-pg";
import bcrypt from 'bcrypt'
import jwt from "jsonwebtoken"

dotenv.config();

// console.log(process.env.CASHFREE_APP_ID)
Cashfree.XClientId = process.env.CASHFREE_APP_ID;

Cashfree.XClientSecret = process.env.CASHFREE_SECRET_KEY;

Cashfree.XEnvironment = CFEnvironment.PRODUCTION;


const resend = new Resend(process.env.RESEND_API_KEY);



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    const { firstName, lastName, email, phone, password, techStack, experience, projects, role, codingLanguages, referredBy } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const userRef = db.ref("users").child(email.replace(/\./g, "_")); // Firebase keys can't have '.'

    const timerSnapshot =
        await db.ref("freeMinsOnRegister").get();
  
      const timer =
      timerSnapshot.val() || '';

    const snapshot = await userRef.get();
    if (snapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    console.log(timer)
    // let timer = 3; 

    const hashedPassword =
    await bcrypt.hash(
      password,
      10
    );

    const userData = {
      firstName,
      lastName,
      email,
      phone,
      password: hashedPassword,
      techStack,
      experience,
      projects,
      role,
      codingLanguages,
      timer,
      disabled: false,
      isAdmin: false,
      createdAt: Date.now(),
      hasUsedFirstPaymentOffer: false,
      isLoggedIn: false,
      referredBy :  referredBy || null
    };

    await userRef.set(userData);
    await resend.emails.send({
      from:
        "Krack-AI <welcome@mail.krack-ai.com>",
    
      to: email,
    
      subject:
        "🎉 Welcome to Krack-AI",
    
      html: `
      <div style="
        font-family:Arial,sans-serif;
        background:#f5f5f5;
        padding:40px 20px;
      ">
    
        <div style="
          max-width:600px;
          margin:auto;
          background:white;
          border-radius:16px;
          overflow:hidden;
          box-shadow:0 10px 30px rgba(0,0,0,.08);
        ">
    
          <div style="
            background:linear-gradient(
              135deg,
              #ff5f6d,
              #ffc371
            );
            padding:40px;
            text-align:center;
            color:white;
          ">
    
            <h1 style="margin:0;">
              Welcome to Krack-AI 🚀
            </h1>
    
          </div>
    
          <div style="padding:40px;">
    
            <h2>
              Hi ${firstName},
            </h2>
    
            <p style="
              font-size:16px;
              line-height:1.8;
              color:#555;
            ">
              Thank you for joining Krack-AI.
              Your account has been created successfully.
            </p>
    
            <div style="
              margin:30px 0;
              background:#fff4f4;
              border:2px dashed #ff5f6d;
              border-radius:12px;
              padding:25px;
              text-align:center;
            ">
    
              <div style="
                font-size:18px;
                color:#666;
                margin-bottom:10px;
              ">
                Welcome Bonus
              </div>
    
              <div style="
                font-size:42px;
                font-weight:bold;
                color:#ff5f6d;
              ">
                ${timer} Minutes
              </div>
    
              <div style="
                margin-top:10px;
                color:#666;
              ">
                Added to your account for free
              </div>
    
            </div>
    
            <h3>
              What you can do now:
            </h3>
    
            <ul style="
              line-height:2;
              color:#555;
            ">
              <li>✅ Practice technical interviews</li>
              <li>✅ Get AI-powered interview guidance</li>
              <li>✅ Generate coding solutions instantly</li>
              <li>✅ Prepare for real interviews confidently</li>
            </ul>
    
            <div style="
              text-align:center;
              margin-top:35px;
            ">
              <a
                href="https://krack-ai.com"
                style="
                  display:inline-block;
                  background:linear-gradient(
                    135deg,
                    #ff5f6d,
                    #ffc371
                  );
                  color:white;
                  text-decoration:none;
                  padding:16px 32px;
                  border-radius:999px;
                  font-weight:bold;
                "
              >
                Start Using Krack-AI
              </a>
            </div>
    
          </div>
    
          <div style="
            background:#fafafa;
            text-align:center;
            padding:20px;
            color:#999;
            font-size:13px;
          ">
            © ${new Date().getFullYear()} Krack-AI
          </div>
    
        </div>
    
      </div>
      `,
    });
    res.json({ message: "User registered successfully", user: {...userData, freeMinsOnRegister: timer} });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v2/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password required" });
    }

    const userRef = db
      .ref("users")
      .child(email.replace(/\./g, "_"));

    const snapshot = await userRef.get();

    // user not found
    if (!snapshot.exists()) {
      return res
        .status(404)
        .json({ error: "User not found" });
    }

    const user = snapshot.val();

    // // disabled account check
    // if (user.disabled) {
    //   return res
    //     .status(403)
    //     .json({ error: "Account disabled" });
    // }

    // password check
    let isMatch = false;

if (user.password.startsWith("$2")) {
  // bcrypt user
  isMatch = await bcrypt.compare(
    password,
    user.password
  );
} else {
  // old plain text user
  isMatch = password === user.password;

  // upgrade to bcrypt automatically
  if (isMatch) {
    const newHash =
      await bcrypt.hash(password, 10);

    await userRef.update({
      password: newHash,
    });
  }
}

if (!isMatch) {
  return res.status(401).json({
    error: "Invalid credentials",
  });
}

  delete user.password;

  const token = jwt.sign(
    {
      email: user.email,
      isAdmin: user.isAdmin || false,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      techStack: user.techStack,
      experience: user.experience,
      projects: user.projects,
      role: user.role,
      codingLanguages: user.codingLanguages,
      timer: user.timer,
      hasUsedFirstPaymentOffer: user.hasUsedFirstPaymentOffer,
      referrals: user.referrals
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );

    // return only required fields
    let responseUser = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      techStack: user.techStack,
      experience: user.experience,
      projects: user.projects,
      role: user.role,
      codingLanguages: user.codingLanguages,
      timer: user.timer,
      hasUsedFirstPaymentOffer: user.hasUsedFirstPaymentOffer,
    };

    if(user.isAdmin === true){
      responseUser.isAdmin = user.isAdmin
    }

    res
.cookie(
  "token",
  token,
  {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge:
      7 * 24 * 60 * 60 * 1000,
  }
)
.json({
  message: "Login successful",
  user: responseUser,
});

  } catch (err) {
    console.error("Login error:", err);

    res.status(500).json({
      error: err.message,
    });
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
    const remainingMinutes = remaining == '0' ? '0' :
      Math.max(
        Math.ceil((remaining || 0) / 60),
        0
      ) - 1;

    await userRef.update({
      timer: remainingMinutes,
      expiryTime: null,
      disabled: remainingMinutes <= 0,
      isLoggedIn: false
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

    if (user.disabled) return res.status(403).json({ error: "User is disabled, please buy minutes to use application" });
    let isMatch = false;

if (user.password.startsWith("$2")) {
  // bcrypt password
  isMatch = await bcrypt.compare(password, user.password);
} else {
  // legacy plaintext password
  isMatch = password === user.password;

  // auto-upgrade to bcrypt
  if (isMatch) {
    const newHash = await bcrypt.hash(password, 10);

    await userRef.update({
      password: newHash,
    });

    user.password = newHash;
  }
}

if (!isMatch) {
  return res.status(401).json({
    error: "Invalid credentials",
  });
}

    if (user.isLoggedIn) {
      return res.status(409).json({
        error: "User is already logged in on another device"
      });
    }

    delete user.password;


    // Set expiry
    const expiryTime = Date.now() + user.timer * 60 * 1000;

await userRef.update({
  expiryTime,
  isLoggedIn: true,
  loginTime: Date.now(),
});

res.json({
  message: "Login successful",
  name: `${user.firstname} ${user.lastname}`,
  timer: user.timer,
  isAdmin: user.isAdmin || false,
  expiryTime,
  ...user,
});

    // Auto disable after timer expires
    // setTimeout(async () => {
    //   if (user.isAdmin == false || !user.isAdmin)
    //     await userRef.update({ disabled: true, timer:0 });
    //   console.log(`User ${email} disabled after ${user.timer} mins`);
    // }, user.timer * 60 * 1000);

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

app.post("/api/send-otp", async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email required"
      });
    }

    const userKey = email.replace(/\./g, "_");

    // Check existing user
    const userSnapshot = await db
      .ref("users")
      .child(userKey)
      .get();

    if (userSnapshot.exists()) {
      return res.status(400).json({
        success: false,
        message: "User already exists. Please login."
      });
    }

    // Generate OTP
    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    // Save OTP
    await db
      .ref("otp")
      .child(userKey)
      .set({
        otp,
        createdAt: Date.now()
      });

    // Send email
    await resend.emails.send({
      from:
        "Krack-AI OTP <otp@mail.krack-ai.com>",

      to: email,

      subject: "Your OTP Verification Code",

      html: `
      <div style="font-family:Arial;padding:40px;background:#f4f4f4">
        <div style="max-width:500px;margin:auto;background:#fff;
        padding:30px;border-radius:12px;text-align:center">

          <h2>Hello ${name}, Verify Your Email</h2>

          <p>
            Use the OTP below to complete verification
          </p>

          <div style="
            font-size:28px;
            font-weight:bold;
            letter-spacing:8px;
            background:#f8f9fa;
            padding:20px;
            border-radius:10px;
            color:#ff5f6d;
          ">
            ${otp}
          </div>

          <p>
            OTP expires in 5 minutes
          </p>

          <small>
            Ignore if not requested
          </small>

        </div>
      </div>
      `
    });

    res.json({
      success: true,
      message: "OTP sent"
    });

  } catch (err) {

    console.log(err);

    res.status(500).json({
      success: false,
      message: err.message
    });

  }
});

app.post("/api/verify-otp", async (req, res) => {

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

app.put(
  "/api/update-profile",

  async (
    req,
    res
  ) => {

    try {

      const {

        email,
        firstName,
        lastName,
        techStack,
        experience,
        codingLanguages,
        projects

      }
        =
        req.body;


      const userRef =
        db.ref("users")
          .child(
            email.replace(
              /\./g,
              "_"
            )
          );


      await userRef.update({

        firstName,
        lastName,

        techStack,

        experience,

        codingLanguages,

        projects

      });


      const snapshot =
        await userRef.get();

      const user =
        snapshot.val();


      res.json({

        message:
          "Updated",

        user: {

          firstName:
            user.firstName,

          lastName:
            user.lastName,

          email:
            user.email,

          phone:
            user.phone,

          techStack:
            user.techStack,

          experience:
            user.experience,

          projects:
            user.projects,

          role:
            user.role,

          codingLanguages:
            user.codingLanguages,

          timer:
            user.timer

        }

      });

    }
    catch (err) {

      res.status(500)
        .json({

          error:
            err.message

        });

    }

  });

app.get("/api/plans", async (req, res) => {
  try {

    const snapshot =
      await db.ref("plans").get();

    const plans =
      snapshot.val() || {};

    res.json(
      Object.values(plans)
        .filter(plan => plan.active)
    );

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }
});

app.post(
  "/api/create-payment",

  async (req, res) => {

    try {

      const {
        email,
        phone,
        planId
      }
        =
        req.body;


      if (
        !email 
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "Email required"

          });

      }

      const planSnap =
        await db
          .ref(`plans/${planId}`)
          .get();

      if (!planSnap.exists()) {
        return res.status(400).json({
          error: "Invalid plan"
        });
      }

      const plan = planSnap.val();

      const amount =
      Number(plan.offerPrice);


      const orderId =
        "ORDER_" +
        Date.now();


      const request = {

        order_amount:
          Number(amount),

        order_currency:
          "INR",

        order_id:
          orderId,

        customer_details: {

          customer_id:
          email.replace(
            /[^a-zA-Z0-9]/g,
            "_"
          ),

          customer_email: email,

          customer_phone: String(
            phone
           )
           .replace(
            /^0+/,
            ""
           ),

        },

        order_meta: {

          return_url:

            `https://www.krack-ai.com/?order_id={order_id}`

        }

      };

      const cashfree = new Cashfree(
        CFEnvironment.PRODUCTION,
        process.env.CASHFREE_APP_ID,
        process.env.CASHFREE_SECRET_KEY
      )
      const response = await cashfree.PGCreateOrder(request);

      const userKey =
          email.replace(
          /\./g,
          "_"
          );
      
          await db
            .ref(`users/${userKey}/payments/${orderId}`)
            .set({
              orderId,
              email,

              planId: plan.id,
              planName: plan.name,

              originalPrice:
                plan.originalPrice,

              offerPrice:
                plan.offerPrice,

              minutes:
                plan.minutes,

              bonusMinutes:
                plan.bonusMinutes,

              status: "PENDING",

              createdAt: Date.now()
            });

        console.log(
          JSON.stringify(
            response.data,
            null,
            2
          )
         );


      res.json({

        success: true,

        orderId,

        paymentSessionId:

          response.data
            .payment_session_id

      });

    }
    catch (err) {

      console.log(err);

      res.status(500)
        .json({

          success: false,

          error:
            err.message

        });

    }

  });

app.get(

  "/api/verify-payment/:orderId",

  async (req, res) => {

    try {

      const {

        orderId

      }
        =
        req.params;

        const cashfree = new Cashfree(
          CFEnvironment.PRODUCTION,
          process.env.CASHFREE_APP_ID,
          process.env.CASHFREE_SECRET_KEY
        )
      const response =

        await cashfree
          .PGFetchOrder(

            orderId

          );

          console.log(
            JSON.stringify(
             response.data,
             null,
             2
            )
           );


      const paymentStatus =

        response.data
          .order_status;


          if(
            paymentStatus==="PAID"
           ){
           
            const users =
            (
             await db.ref(
              "users"
             ).get()
            ).val();
           
           
            let payment;
            let userKey;
           
           
            for(
             let key in users
            ){
           
              if(
               users[key]
               ?.payments
               ?.[orderId]
              ){
           
                payment =
                users[key]
                .payments[
                 orderId
                ];
           
                userKey =
                key;
           
                break;
              }
           
            }

            const user = users[userKey];

            const previousSuccessPayments =
              Object.values(
                user.payments || {}
              ).filter(
                p =>
                  p.status === "SUCCESS" &&
                  p.orderId !== orderId
              );

            const isFirstPayment =
              previousSuccessPayments.length === 0;

            let creditedMinutes =
              payment.minutes;

            if (
              isFirstPayment &&
              payment.bonusMinutes
            ) {
              creditedMinutes +=
                payment.bonusMinutes;
            }
           
           
            if(
             !payment
            ){
           
             return res.json({
           
               error:
               "Payment not found"
           
             });
           
            }
           
           
            // Prevent duplicate timer addition
            if(
             payment.status
             ===
             "SUCCESS"
            ){
           
              return res.json({
           
               success:true,
           
               status:"PAID",
           
               timer:
               users[userKey]
               .timer
           
              });
           
            }
           
           
            let addMinutes =
            0;
           
           
            switch(
             Number(
              payment.amount
             )
            ){
           
             case 99:
              addMinutes=15;
              break;
           
             case 149:
              addMinutes=30;
              break;
           
             case 299:
              addMinutes=60;
              break;
           
            }
           
           
            await db
              .ref(`users/${userKey}`)
              .update({

                timer:
                  (users[userKey].timer || 0)
                  +
                  creditedMinutes,

                disabled: false,
                hasUsedFirstPaymentOffer: true,
                firstPaymentDate: Date.now()
              });
           
           
              await db
  .ref(`users/${userKey}/payments/${orderId}`)
  .update({
    status: "SUCCESS",
    bonusApplied: isFirstPayment,
    creditedMinutes
  });


// REFERRAL REWARD
if (isFirstPayment && user.referredBy) {

  const referrerKey =
    user.referredBy.replace(/\./g, "_");

  const referredKey =
    user.email.replace(/\./g, "_");

  const referralRef =
    db.ref(
      `users/${referrerKey}/referrals/${referredKey}`
    );

  const referralSnap =
    await referralRef.get();

  if (
    referralSnap.exists() &&
    referralSnap.val() === false
  ) {

    const referrerRef =
      db.ref(`users/${referrerKey}`);

    const referrerSnap =
      await referrerRef.get();

    if (referrerSnap.exists()) {

      const referrer =
        referrerSnap.val();

      await referrerRef.update({
        timer: Number(referrer.timer || 0) + 10
      });

      await referralRef.set(true);
    }
  }
}
            const updatedUser =
            (
              await db
              .ref(
               `users/${userKey}`
              )
              .get()
            )
            .val();
           
           
            return res.json({
           
              success:true,
           
              status:"PAID",
           
              timer:
              updatedUser
              .timer
           
            });
           
           }


      res.json({

        success: true,

        status:

          paymentStatus

      });

    }
    catch (err) {

      res.status(500)
        .json({

          error:
            err.message

        });

    }

  });

// app.post(

//   "/api/payment-webhook",

//   async (req, res) => {

//     try {

//       const event =
//         req.body;


//       if (

//         event.type
//         ===

//         "PAYMENT_SUCCESS"

//       ) {

//         const orderId = event.data
//             .order
//             .order_id;


//             const userKey =
//             payment.email
//             .replace(
//             /\./g,
//             "_"
//             );
            
//             const paymentRef =
//             db.ref(
//              `users/${userKey}/payments/${orderId}`
//             );


//         const snap =
//           await paymentRef.get();


//         if (
//           !snap.exists()
//         ) {

//           return res
//             .sendStatus(200);

//         }


//         const payment =
//           snap.val();


//         const userRef =

//           db.ref("users")
//             .child(

//               payment.email
//                 .replace(
//                   /\./g,
//                   "_"

//                 )

//             );


//         let addMinutes = 0;


//         switch (
//         payment.amount
//         ) {

//           case 99:

//             addMinutes = 15;
//             break;


//           case 149:

//             addMinutes = 30;
//             break;


//           case 299:

//             addMinutes = 60;
//             break;

//         }


//         const user =

//           (
//             await userRef.get()
//           )
//             .val();


//         await userRef.update({

//           timer:

//             (
//               user.timer
//               ||
//               0
//             )

//             +

//             addMinutes,

//           disabled: false

//         });


//         await paymentRef.update({

//           status:
//             "SUCCESS"

//         });

//       }


//       res.sendStatus(
//         200
//       );

//     }
//     catch (err) {

//       console.log(err);

//       res.sendStatus(
//         500
//       );

//     }

// });

app.get(

  "/api/payments/:email",

  async (req, res) => {

    try {

      const {
        email
      }
        =
        req.params;


        const userKey =
          email.replace(
          /\./g,
          "_"
          );
        
      const snapshot =
        await db
        .ref(
         `users/${userKey}/payments`
        )
        .get();


      const data =
        snapshot.val()
        ||
        {};


      const payments =

        Object.values(
          data
        )

          .filter(

            x =>

              x.email
              ===

              email

          );


      res.json(
        payments
      );

    }
    catch (err) {

      res.status(500)
        .json({

          error:
            err.message

        });

    }

});

//referral api
app.post("/api/referral", async (req, res) => {
  try {
    const { referrerEmail, referredEmail } = req.body;

    if (!referrerEmail || !referredEmail) {
      return res.status(400).json({
        success: false,
        message: "Both emails are required"
      });
    }

    if (
      referrerEmail.toLowerCase() ===
      referredEmail.toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        message: "You cannot refer yourself"
      });
    }

    const referrerKey =
      referrerEmail.replace(/\./g, "_");

    const referredKey =
      referredEmail.replace(/\./g, "_");

    // 1. Check referrer exists
    const referrerRef =
      db.ref(`users/${referrerKey}`);

    const referrerSnap =
      await referrerRef.get();

    if (!referrerSnap.exists()) {
      return res.status(404).json({
        success: false,
        message: "Referrer not found"
      });
    }

    const referrer = referrerSnap.val();

    // 2. Referrer must have purchased
    const payments =
      Object.values(referrer.payments || {});

    const hasPurchased =
      payments.some(
        payment => payment.status === "SUCCESS"
      );

    if (!hasPurchased) {
      return res.status(403).json({
        success: false,
        message: "Purchase a plan before referring friends"
      });
    }

    // 3. CHECK IF FRIEND ALREADY EXISTS
    const referredUserRef =
      db.ref(`users/${referredKey}`);

    const referredUserSnap =
      await referredUserRef.get();

    if (referredUserSnap.exists()) {
      return res.status(400).json({
        success: false,
        message: "This email is already registered"
      });
    }

    // 4. Add referral to A
    await db
      .ref(
        `users/${referrerKey}/referrals/${referredKey}`
      )
      .set(false);

    // 5. Send email ONLY if B doesn't exist
    const referralLink =
      `https://krack-ai.com/register?ref=${encodeURIComponent(
        referrerEmail
      )}`;

    await resend.emails.send({
      from: "Krack-AI <welcome@mail.krack-ai.com>",
      to: referredEmail,
      subject: "🎁 You have been invited to Krack-AI",
      html: `
        <div style="font-family:Arial;padding:40px">
          <h2>You've been invited to Krack-AI 🚀</h2>

          <p>
            Your friend has invited you to try Krack-AI.
          </p>

          <a
            href="${referralLink}"
            style="
              display:inline-block;
              padding:14px 25px;
              background:#ff5f6d;
              color:white;
              text-decoration:none;
              border-radius:8px;
            "
          >
            Create Your Account
          </a>

          <p>
            When you make your first purchase,
            your friend will receive 10 free minutes.
          </p>
        </div>
      `
    });

    return res.json({
      success: true,
      message: "Referral invitation sent successfully"
    });

  } catch (err) {
    console.error("Referral error:", err);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.post("/api/v2/forgot-password/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const userKey = normalizedEmail.replace(/\./g, "_");

    // Check user exists
    const userRef = db
      .ref("users")
      .child(userKey);

    const userSnapshot = await userRef.get();

    if (!userSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "No account found with this email",
      });
    }

    const user = userSnapshot.val();

    // Generate OTP
    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    // Save OTP
    await db
      .ref("passwordResetOtp")
      .child(userKey)
      .set({
        otp,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
        verified: false,
      });

    // Send email
    await resend.emails.send({
      from: "Krack-AI OTP <otp@mail.krack-ai.com>",
      to: normalizedEmail,
      subject: "Reset Your Krack-AI Password",
      html: `
        <div style="
          font-family:Arial;
          padding:40px;
          background:#f4f4f4;
        ">
          <div style="
            max-width:500px;
            margin:auto;
            background:#fff;
            padding:30px;
            border-radius:12px;
            text-align:center;
          ">

            <h2>
              Reset Your Password 🔐
            </h2>

            <p>
              Hi ${user.firstName || "there"},
            </p>

            <p>
              Use the OTP below to reset your
              Krack-AI password.
            </p>

            <div style="
              font-size:32px;
              font-weight:bold;
              letter-spacing:10px;
              background:#f8f9fa;
              padding:20px;
              border-radius:10px;
              color:#ff5f6d;
              margin:25px 0;
            ">
              ${otp}
            </div>

            <p>
              This OTP will expire in
              <strong>5 minutes</strong>.
            </p>

            <p style="
              color:#777;
              font-size:13px;
            ">
              If you didn't request a password reset,
              you can safely ignore this email.
            </p>

          </div>
        </div>
      `,
    });

    return res.json({
      success: true,
      message: "OTP sent successfully",
    });

  } catch (err) {
    console.error(
      "Forgot password send OTP error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
    });
  }
});

app.post("/api/v2/forgot-password/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email & OTP required",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const userKey =
      normalizedEmail.replace(/\./g, "_");

    const otpRef = db
      .ref("passwordResetOtp")
      .child(userKey);

    const snapshot = await otpRef.get();

    if (!snapshot.exists()) {
      return res.status(400).json({
        success: false,
        message: "OTP not found or expired",
      });
    }

    const savedOtp = snapshot.val();

    // Check expiry
    if (
      Date.now() > savedOtp.expiresAt
    ) {
      await otpRef.remove();

      return res.status(400).json({
        success: false,
        message: "OTP expired",
      });
    }

    // Check OTP
    if (
      savedOtp.otp !== otp.toString().trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // Mark OTP as verified
    await otpRef.update({
      verified: true,
      verifiedAt: Date.now(),
    });

    return res.json({
      success: true,
      message: "OTP verified successfully",
    });

  } catch (err) {
    console.error(
      "Forgot password verify OTP error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: "OTP verification failed",
    });
  }
});

app.post("/api/v2/forgot-password/reset", async (req, res) => {
  try {
    const {
      email,
      otp,
      password,
    } = req.body;

    if (!email || !otp || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Email, OTP and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const userKey =
      normalizedEmail.replace(/\./g, "_");

    // Get reset OTP
    const otpRef = db
      .ref("passwordResetOtp")
      .child(userKey);

    const otpSnapshot = await otpRef.get();

    if (!otpSnapshot.exists()) {
      return res.status(400).json({
        success: false,
        message:
          "Password reset session expired",
      });
    }

    const savedOtp = otpSnapshot.val();

    // Check expiry
    if (
      Date.now() > savedOtp.expiresAt
    ) {
      await otpRef.remove();

      return res.status(400).json({
        success: false,
        message: "OTP expired",
      });
    }

    // Check OTP
    if (
      savedOtp.otp !== otp.toString().trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // OTP must be verified first
    if (!savedOtp.verified) {
      return res.status(400).json({
        success: false,
        message:
          "Please verify OTP first",
      });
    }

    // Check user
    const userRef = db
      .ref("users")
      .child(userKey);

    const userSnapshot =
      await userRef.get();

    if (!userSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Hash new password
    const hashedPassword =
      await bcrypt.hash(password, 10);

    // Update password
    await userRef.update({
      password: hashedPassword,
    });

    // Delete OTP after successful reset
    await otpRef.remove();

    return res.json({
      success: true,
      message:
        "Password reset successfully",
    });

  } catch (err) {
    console.error(
      "Reset password error:",
      err
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to reset password",
    });
  }
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
