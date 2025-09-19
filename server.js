// server.js (ESM) — Halfords Agent proxy + static host (hardened)
// ----------------------------------------------------------------
// Required .env (next to this file):
//   TENANT_ID, CLIENT_ID, CLIENT_SECRET
//   PROJECT_ENDPOINT  e.g. https://.../api/projects/HalGenAI
//   ASSISTANT_ID      e.g. asst_xxxxx
// Optional:
//   AGENT_SCOPE (default: https://ai.azure.com/.default)
//   ALLOW_ORIGIN (csv) e.g. https://yourdomain,http://localhost:5173
//   NODE_ENV=production

import express from "express";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, ".env");
dotenv.config({ path: ENV_PATH });

const readEnv = (...keys) => {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
};

const TENANT_ID       = readEnv("AZURE_TENANT_ID", "TENANT_ID");
const CLIENT_ID       = readEnv("AZURE_CLIENT_ID", "CLIENT_ID");
const CLIENT_SECRET   = readEnv("AZURE_CLIENT_SECRET", "CLIENT_SECRET");
const AGENT_SCOPE     = readEnv("AGENT_SCOPE", "AZURE_AGENT_SCOPE") || "https://ai.azure.com/.default";
const PROJECT_ENDPOINT= readEnv("PROJECT_ENDPOINT");
const ASSISTANT_ID    = readEnv("ASSISTANT_ID");
const ALLOW_ORIGIN    = readEnv("ALLOW_ORIGIN");

const missing = [];
if (!TENANT_ID)        missing.push("TENANT_ID");
if (!CLIENT_ID)        missing.push("CLIENT_ID");
if (!CLIENT_SECRET)    missing.push("CLIENT_SECRET");
if (!PROJECT_ENDPOINT) missing.push("PROJECT_ENDPOINT");
if (!ASSISTANT_ID)     missing.push("ASSISTANT_ID");
if (missing.length) {
  console.error(`[proxy] Missing env: ${missing.join(", ")}
  cwd=${process.cwd()}
  envPath=${ENV_PATH} exists=${fs.existsSync(ENV_PATH)}`);
  process.exit(1);
}

const isProd = process.env.NODE_ENV === "production";

// ---------- Express ----------
const app = express();

// Security & limits
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ALLOW_ORIGIN
    ? ALLOW_ORIGIN.split(",").map(s => s.trim()).filter(Boolean)
    : [/^http:\/\/localhost:\d+$/]
}));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.use(morgan(isProd ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));

// Static front-end
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- Token cache ----------
let cachedToken = null; // { access_token, expiresAt }
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.access_token;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: AGENT_SCOPE
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("[token] failed:", resp.status, resp.statusText, text);
    throw new Error(`Token request failed: ${resp.status} ${resp.statusText}`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("Token response missing access_token");

  const expiresIn = Number(data.expires_in || 3600);
  cachedToken = {
    access_token: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + Math.min(Math.max(expiresIn, 60), 86400)
  };
  return cachedToken.access_token;
}

//--new//
function extractUserText(body = {}) {
  // Preferred minimal shape
  if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  if (typeof body.input === "string" && body.input.trim()) return body.input.trim();

  // Legacy/Foundry-style: payload.thread.messages[0].content
  const p = body.payload;
  const msgs = p?.thread?.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const m0 = msgs[0];
    // Common: { role: "user", content: "…" }
    if (typeof m0?.content === "string" && m0.content.trim()) return m0.content.trim();
    // Just in case: { content: { text: "…" } }
    if (typeof m0?.content?.text === "string" && m0.content.text.trim()) return m0.content.text.trim();
    // Or OpenAI-ish: { content: [{ type: "text", text: { value: "…" } }] }
    if (Array.isArray(m0?.content)) {
      const t = m0.content.find(c => c?.type === "text");
      const v = t?.text?.value || t?.text || t?.value;
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}


// ---------- Minimal projections ----------
const projectRun = (r = {}) => ({
  id: r.id,
  status: r.status,
  thread_id: r.thread_id,
  created_at: r.created_at,
  started_at: r.started_at,
  completed_at: r.completed_at
});

// Keep message shape compatible with your UI: provide content[] with a single text part
// Add server-side stripper
function stripAgentCitations(text = "") {
  return text.replace(/\u3010[\s\S]*?\u3011/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

const projectMsgList = (j = {}) => ({
  data: (j.data || []).map(m => {
    let txt = "";
    if (Array.isArray(m.content)) {
      const t = m.content.find(c => c?.type === "text");
      txt = t?.text?.value || "";
    } else if (m?.content?.text?.value) {
      txt = m.content.text.value;
    } else if (typeof m?.content?.value === "string") {
      txt = m.content.value;
    }
    txt = stripAgentCitations(txt); // <-- scrub here
    return {
      role: m.role,
      created_at: m.created_at,
      content: [{ type: "text", text: { value: txt } }]
    };
  })
});


// ---------- Health ----------
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), note: "Proxy reachable" });
});

// Dev-only env probe (booleans only)
if (!isProd) {
  app.get("/api/env-check", (_req, res) => {
    res.json({
      envPath: ENV_PATH,
      exists: fs.existsSync(ENV_PATH),
      has: {
        TENANT_ID: !!TENANT_ID,
        CLIENT_ID: !!CLIENT_ID,
        CLIENT_SECRET: !!CLIENT_SECRET,
        PROJECT_ENDPOINT: !!PROJECT_ENDPOINT,
        ASSISTANT_ID: !!ASSISTANT_ID,
        AGENT_SCOPE: !!AGENT_SCOPE
      }
    });
  });
}

// ---------- Agents proxy (no upstream leakage) ----------

// POST /api/threads-runs   accepts either { text }  OR  { payload: { thread: { messages:[{content}] } } }
app.post("/api/threads-runs", async (req, res) => {
  try {
    const text = extractUserText(req.body);
    if (!text) return res.status(400).json({ error: { message: "Missing text" } });

    const token = await getAccessToken();
    const url = `${PROJECT_ENDPOINT}/threads/runs?api-version=v1`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Always use server-side ASSISTANT_ID; ignore any client-supplied assistant_id
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        thread: { messages: [{ role: "user", content: text }] }
      })
    });

    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: { message: "Upstream error" } });

    return res.json({
      thread: { id: body.thread_id || body.thread?.id || null },
      run: {
        id: body.id,
        status: body.status,
        thread_id: body.thread_id,
        created_at: body.created_at,
        started_at: body.started_at,
        completed_at: body.completed_at
      }
    });
  } catch {
    return res.status(500).json({ error: { message: "Server error" } });
  }
});


// POST /api/append-message  { threadId, content }
app.post("/api/append-message", async (req, res) => {
  try {
    const { threadId, content } = req.body || {};
    if (!threadId || !String(content || "").trim()) {
      return res.status(400).json({ error: { message: "Missing fields" } });
    }

    const token = await getAccessToken();
    const url = `${PROJECT_ENDPOINT}/threads/${encodeURIComponent(threadId)}/messages?api-version=v1`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content })
    });

    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: "Upstream error" } });
    return res.json({ ok: true, id: j.id });
  } catch {
    return res.status(500).json({ error: { message: "Server error" } });
  }
});

// POST /api/start-run  { threadId }
app.post("/api/start-run", async (req, res) => {
  try {
    const { threadId } = req.body || {};
    if (!threadId) return res.status(400).json({ error: { message: "Missing threadId" } });

    const token = await getAccessToken();
    const url = `${PROJECT_ENDPOINT}/threads/${encodeURIComponent(threadId)}/runs?api-version=v1`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: "Upstream error" } });
    return res.json(projectRun(j));
  } catch {
    return res.status(500).json({ error: { message: "Server error" } });
  }
});

// GET /api/run-status?threadId=&runId=
app.get("/api/run-status", async (req, res) => {
  try {
    const { threadId, runId } = req.query || {};
    if (!threadId || !runId) return res.status(400).json({ error: { message: "Missing ids" } });

    const token = await getAccessToken();
    const url = `${PROJECT_ENDPOINT}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}?api-version=v1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: "Upstream error" } });

    return res.json({ status: j.status });
  } catch {
    return res.status(500).json({ error: { message: "Server error" } });
  }
});

// GET /api/messages?threadId=
app.get("/api/messages", async (req, res) => {
  try {
    const { threadId } = req.query || {};
    if (!threadId) return res.status(400).json({ error: { message: "Missing threadId" } });

    const token = await getAccessToken();
    const url = `${PROJECT_ENDPOINT}/threads/${encodeURIComponent(threadId)}/messages?api-version=v1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: { message: "Upstream error" } });

    return res.json(projectMsgList(j)); // only role + plain text + timestamp
  } catch {
    return res.status(500).json({ error: { message: "Server error" } });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[proxy] listening on ${PORT}`));
