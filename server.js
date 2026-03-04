{\rtf1\ansi\ansicpg1252\cocoartf2868
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 import express from "express";\
import \{ OAuth2Client \} from "google-auth-library";\
\
const app = express();\
app.use(express.json());\
\
const WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;\
if (!WEB_CLIENT_ID) throw new Error("Missing GOOGLE_WEB_CLIENT_ID");\
\
const googleClient = new OAuth2Client(WEB_CLIENT_ID);\
\
app.get("/health", (req, res) => res.json(\{ ok: true \}));\
\
app.post("/v1/auth/google/ios", async (req, res) => \{\
  try \{\
    const \{ idToken \} = req.body || \{\};\
    if (!idToken) return res.status(400).json(\{ error: "Missing idToken" \});\
\
    const ticket = await googleClient.verifyIdToken(\{\
      idToken,\
      audience: WEB_CLIENT_ID\
    \});\
\
    const payload = ticket.getPayload();\
    if (!payload) return res.status(401).json(\{ error: "Invalid token" \});\
\
    return res.json(\{\
      googleSub: payload.sub,\
      email: payload.email,\
      name: payload.name,\
      picture: payload.picture\
    \});\
  \} catch \{\
    return res.status(401).json(\{ error: "Token verification failed" \});\
  \}\
\});\
\
const port = process.env.PORT || 3000;\
app.listen(port, () => console.log(`API listening on $\{port\}`));}