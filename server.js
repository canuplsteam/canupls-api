import express from "express";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(express.json());

const WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
if (!WEB_CLIENT_ID) throw new Error("Missing GOOGLE_WEB_CLIENT_ID");

const googleClient = new OAuth2Client(WEB_CLIENT_ID);

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/v1/auth/google/ios", async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: "Missing idToken" });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: WEB_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    res.json({
      googleSub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    });
  } catch (err) {
    res.status(401).json({ error: "Token verification failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
