// public/chat.js
// Modular chat UI with form fragments + feedback stars.
// Uses your Azure AI Foundry project + assistant IDs and your Express proxy.

/* ====== CONFIG ====== */
const PROJECT_ENDPOINT = "https://aiandautoaifoundry.services.ai.azure.com/api/projects/HalGenAI";
const ASSISTANT_ID    = "asst_mTjocL4RbpsVMQ73zHHph9W3";

/* Proxy base (file:// safe + same-origin by default) */
const DEFAULT_PROXY = "http://localhost:3000/api";
const fromWindow = (typeof window !== "undefined" && (window.PROXY_BASE || "")).trim();
const validOverride = /^https?:\/\//i.test(fromWindow) ? fromWindow.replace(/\/$/, "") : null;
const PROXY_BASE =
  validOverride ||
  (/^file:/i.test(window.location.origin)
    ? DEFAULT_PROXY
    : window.location.origin.replace(/\/$/, "") + "/api");


    /* ====== Forms routing ====== */
const FORM_MAP = {
  // actions → fragment filenames (without .html)
  "wimo": "track-order",
  "c2w": "c2w-status",
  "loyalty": "loyalty-signup",

  // also allow direct names so data-form="loyalty-signup" works
  "track-order": "track-order",
  "c2w-status": "c2w-status",
  "loyalty-signup": "loyalty-signup",
};

function openForm(nameLike) {
  const key = String(nameLike || "").trim();
  const mapped = FORM_MAP[key] || key;
  log(`🧩 openForm(${key}) → ${mapped}`);
  return renderFormFragment(mapped);
}

/* ===== Theme toggle ===== */
const THEME_KEY = "halfordsTheme";

/** Apply a theme: "light" | "dark" */
function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById("themeToggle");
  if (btn) {
    const isDark = theme === "dark";
    btn.textContent = isDark ? "☀️" : "🌙";
    btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-pressed", String(isDark));
  }
}

/* ===== Accessible mode toggle ===== */
const A11Y_KEY = "halfordsA11y";

/** Apply or remove accessible mode */
function applyA11y(enabled) {
  document.documentElement.classList.toggle("a11y", !!enabled);
  localStorage.setItem(A11Y_KEY, enabled ? "1" : "0");
  const btn = document.getElementById("a11yToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", String(!!enabled));
    btn.textContent = enabled ? "A11y✓" : "A11y";
    btn.title = enabled ? "Switch off accessible mode" : "Switch on accessible mode";
  }
}

/** Initialise from saved preference */
function initA11y() {
  const saved = localStorage.getItem(A11Y_KEY) === "1";
  applyA11y(saved);
}

document.addEventListener("DOMContentLoaded", () => {
  initA11y();
  const a11yBtn = document.getElementById("a11yToggle");
  a11yBtn?.addEventListener("click", () => {
    const on = document.documentElement.classList.contains("a11y");
    applyA11y(!on);
  });
});


/** Decide initial theme from saved preference or OS */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
  } else {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }

  // If user hasn't chosen manually, follow OS changes live
  if (!localStorage.getItem(THEME_KEY)) {
    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", (e) => applyTheme(e.matches ? "dark" : "light"));
    } catch {}
  }
}

// Wire up the button (works even if added later)
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const isDark = document.documentElement.classList.contains("dark");
      applyTheme(isDark ? "light" : "dark");
    });
  }
});

/* ====== UI + logging ====== */
const el = id => document.getElementById(id);
const $messages = el("messages");
const $log = el("log");
const $status = el("status");
if (!$messages) throw new Error("Missing #messages container – check your index.html");

let threadId = null;
let sending = false;
let pendingFeedback = false;

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "Z");
const log = (...args) => { if ($log) $log.textContent += `[${now()}] ${args.join(" ")}\n`; };

/* ====== Autoscroll sentinel ====== */
let $bottom = document.getElementById("bottomSentinel");
if (!$bottom) {
  $bottom = document.createElement("div");
  $bottom.id = "bottomSentinel";
  $bottom.style.cssText = "height:1px;";
  $messages.appendChild($bottom);
}
function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = $messages;
  return (scrollHeight - (scrollTop + clientHeight)) < 80;
}
let stickToBottom = true;
$messages.addEventListener("scroll", () => { stickToBottom = isNearBottom(); });
let scrollRaf = 0;
function ensureBottomSoon({ smooth = true } = {}) {
  if (!stickToBottom) return;
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      $bottom.scrollIntoView({ block: "end", inline: "nearest", behavior: smooth ? "smooth" : "instant" });
    });
  });
}
const mo = new MutationObserver(() => ensureBottomSoon({ smooth: true }));
mo.observe($messages, { childList: true, subtree: true });
window.addEventListener("resize", () => ensureBottomSoon({ smooth: false }));


/* ====== Markdown (safe/minimal) ====== */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function mdToHtml(md) {
  // 0) Escape first
  let s = escapeHtml(String(md || ''));

  // 1) Code fences (```lang\n...\n```)
  s = s.replace(/```([a-z0-9_-]+)?\n([\s\S]*?)```/gi, (_m, _lang, code) =>
    `<pre><code>${code.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</code></pre>`
  );
  // 2) Inline code
  s = s.replace(/`([^`]+?)`/g, (_m, code) => `<code>${code}</code>`);

  // --- Protect code chunks so we don't autolink inside them ---
  const blocks = [];
  s = s.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, (m) => {
    const i = blocks.push(m) - 1;
    return `@@CB${i}@@`;
  });
  const inlines = [];
  s = s.replace(/<code>[\s\S]*?<\/code>/g, (m) => {
    const i = inlines.push(m) - 1;
    return `@@IC${i}@@`;
  });

  // 3) Headings, strong/emphasis, quotes, lists
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, text) => {
    const n = Math.min(hashes.length, 6);
    return `<h${n}>${text}</h${n}>`;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  s = s.replace(/^>\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/(^|\n)(?:\d+\.\s.*(?:\n\d+\.\s.*)*)/g, block => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^\d+\.\s/, '').trim());
    return `\n<ol>\n${items.map(it=>`<li>${it}</li>`).join('\n')}\n</ol>`;
  });
  s = s.replace(/(^|\n)(?:[-*]\s.*(?:\n[-*]\s.*)*)/g, block => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^[-*]\s/, '').trim());
    return `\n<ul>\n${items.map(it=>`<li>${it}</li>`).join('\n')}\n</ul>`;
  });

  // 4) Markdown links [text](url) (keep as-is)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, url) => {
    if (!/^https?:\/\//i.test(url)) return txt;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(txt)}</a>`;
  });

  // 5) Auto-link bare URLs / angle-bracket links / www. links
  // angle-bracket form like <https://example.com> (escaped as &lt;https...&gt;)
  s = s.replace(/&lt;(https?:\/\/[^ >]+)&gt;/gi, (_m, url) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
  );
  // www. links (no scheme)
  s = s.replace(/(^|[\s(])((?:www\.)[^\s<>()]+[^\s<>().,!?;:'"])/gi, (_m, pre, host) =>
    `${pre}<a href="https://${escapeHtml(host)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>`
  );
  // http(s) bare links – exclude trailing punctuation
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+?)(?=[\s)]|$)/gi, (_m, pre, url) => {
    // strip trailing punctuation that often follows links
    const cleaned = url.replace(/[),.;:!?]+$/,'');
    return `${pre}<a href="${escapeHtml(cleaned)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleaned)}</a>`;
  });

  // 6) Paragraphs
  s = s.replace(/\n{2,}/g, '</p><p>');
  s = `<p>${s}</p>`;
  s = s.replace(/<p>\s*<\/p>/g, '');
  s = s.replace(/<p>(<(?:h\d|ul|ol|pre|blockquote)[\s\S]*?<\/(?:h\d|ul|ol|pre|blockquote)>)<\/p>/g, '$1');

  // --- Restore code chunks ---
  s = s.replace(/@@CB(\d+)@@/g, (_m, i) => blocks[+i]);
  s = s.replace(/@@IC(\d+)@@/g, (_m, i) => inlines[+i]);

  return s;
}



/* ====== Extract text from Agent message shapes ====== */
function extractAssistantText(msg) {
  const out = [];
  const take = (it) => {
    if (!it) return;
    if (typeof it === "string") { out.push(it); return; }
    if (it.type === "text" && it.text && typeof it.text.value === "string") { out.push(it.text.value); return; }
    if (typeof it.text === "string") { out.push(it.text); return; }
    if (typeof it.output_text === "string") { out.push(it.output_text); return; }
    if (it.output_text && typeof it.output_text.value === "string") { out.push(it.output_text.value); return; }
    if (typeof it.value === "string") { out.push(it.value); return; }
    if (it.type?.includes("image") || it.image || it.image_file) { out.push("[Image output]"); return; }
    out.push(JSON.stringify(it));
  };
  try { if (Array.isArray(msg.content)) for (const c of msg.content) take(c); else take(msg.content); } catch {}
  return out.join("\n\n").trim();
}

/* ====== Message rendering ====== */
function addMsg(role, html) {
  const row = document.createElement("div");
  row.className = "msg " + (role === "user" ? "user" : "assistant");
  const avatar = document.createElement("div");
  avatar.className = "avatar " + (role === "assistant" ? "h" : "");
  avatar.textContent = role === "assistant" ? "H" : "You";
  const wrap = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "meta"; meta.textContent = role === "assistant" ? "Assistant" : "You";
  const bubble = document.createElement("div");
  bubble.className = "bubble"; bubble.innerHTML = html;
  wrap.appendChild(meta); wrap.appendChild(bubble);
  row.appendChild(avatar); row.appendChild(wrap);
  $messages.insertBefore(row, $bottom);

  // keep autoscroll for late-loading images
  for (const img of bubble.querySelectorAll("img")) {
    if (!img.complete) {
      img.addEventListener("load", () => ensureBottomSoon({ smooth: true }), { once: true });
      img.addEventListener("error", () => ensureBottomSoon({ smooth: true }), { once: true });
    }
  }
  ensureBottomSoon({ smooth: true });
  return bubble;
}
let typingEl = null;
function showTyping(){ typingEl = addMsg("assistant", `<span class="typing"><span></span><span></span><span></span></span>`); }
function hideTyping(){ if (typingEl && typingEl.closest(".msg")) typingEl.closest(".msg").remove(); typingEl = null; ensureBottomSoon({ smooth: true }); }

/* ====== Suggestions for /newChat (optional) ====== */
const SUGGESTIONS = [
  { label: "Track my order", prompt: "Where is my order?", action: "wimo" },
  { label: "Find a store", prompt: "Find my nearest Halfords store." },
  { label: "Help me choose", prompt: "Help me choose a bike." },
  { label: "Cycle2Work status", prompt: "Check my Cycle to Work status.", action: "c2w" },
  { label: "Book a bike service", prompt: "I want to book a bike service." },
  { label: "What Motoring Club Benefits do I have left?", prompt: "What Motoring Club Benefits do I have left" },
  { label: "Join the Motoring Club",       prompt: "Join loyalty", action: "loyalty" }
];

/* ====== Form loading (modular fragments) ====== */
async function renderFormFragment(name) {
  const url = `./forms/${name}.html`;
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`Failed to load ${name} form (${resp.status})`);
    const html = await resp.text();
    const bubble = addMsg("assistant", html);

    const form = bubble.querySelector("form#tool-form");
    if (!form) return;

    const cancelBtn = form.querySelector("[data-cancel]");
    if (cancelBtn) cancelBtn.addEventListener("click", () => bubble.closest(".msg")?.remove());

    form.addEventListener("submit", (e) => {
      e.preventDefault();

      // Helper: get ALL fields, including unchecked checkboxes
      const formData = new FormData(form);
      const entries = Object.fromEntries(formData.entries());
      const getBool = (n) => !!form.querySelector(`[name="${CSS.escape(n)}"]`)?.checked;

      // Disable inputs to avoid duplicate submits
      form.querySelectorAll("input,button,select,textarea").forEach(n => n.disabled = true);

      if (name === "track-order") {
        const { orderNumber = "", Email = "" } = entries;
        addMsg("user", mdToHtml(`Where is my order?\n\n**orderNumber:** ${orderNumber}\n**Email:** ${Email}`));
        sendMessage(`Where is my order? orderNumber: ${orderNumber}, Email: ${Email}`);
      }
      else if (name === "c2w-status") {
        const { AgreementNumber = "" } = entries;
        addMsg("user", mdToHtml(`Check my Cycle to Work status.\n\n**AgreementNumber:** ${AgreementNumber}`));
        sendMessage(`Check my Cycle to Work status. AgreementNumber: ${AgreementNumber}`);
      }
else if (name === "loyalty-signup") {
  // ----- Validation (only firstName + email required) -----
  const ensureErrorEl = () => {
    let el = form.querySelector(".mini-error");
    if (!el) { el = document.createElement("div"); el.className = "mini-error"; form.appendChild(el); }
    return el;
  };
  const errEl = ensureErrorEl(); errEl.textContent = "";

  const firstName = (entries.firstName || "").trim();
  const emailRaw  = (entries.emailAddress || "").trim();
  const emailOk   = !emailRaw || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);

  const errors = [];
  if (!firstName) errors.push("First name is required.");
  if (!emailRaw) errors.push("Email is required.");
  else if (!emailOk) errors.push("Please enter a valid email address.");
  if (errors.length) { errEl.textContent = errors.join(" "); return; }

  // ----- Normalisers -----
  const trim = v => (v ?? "").toString().trim();
  const normUpperSpaced = v => trim(v).toUpperCase().replace(/\s+/g, " ");
  const normPostcode = v => {
    const s = trim(v).toUpperCase().replace(/\s+/g, "");
    return s.length >= 5 ? s.slice(0, -3) + " " + s.slice(-3) : s;
  };
  const normMileage = v => {
    const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? String(n) : "";
  };

  // ----- Build payload -----
  const payload = {
    title: trim(entries.title),
    firstName,
    lastName: trim(entries.lastName),
    address: {
      addressLine1: trim(entries["address.addressLine1"]),
      addressLine2: trim(entries["address.addressLine2"]),
      addressLine3: trim(entries["address.addressLine3"]),
      addressLine4: trim(entries["address.addressLine4"]),
      addressLine5: trim(entries["address.addressLine5"]),
      addressPostcode: normPostcode(entries["address.addressPostcode"])
    },
    emailAddress: emailRaw.toLowerCase(),
    phoneNumber: trim(entries.phoneNumber),
    groupMarketing: {
      emailConsent:  getBool("groupMarketing.emailConsent"),
      smsConsent:    getBool("groupMarketing.smsConsent"),
      phoneConsent:  getBool("groupMarketing.phoneConsent"),
      directConsent: getBool("groupMarketing.directConsent")
    },
    vrn: normUpperSpaced(entries.vrn),
    mileage: normMileage(entries.mileage)
  };

  // ----- Send to the agent (no JSON echo to user) -----
  // If you want a tiny visual ack, uncomment the next line:
  // addMsg("assistant", mdToHtml("Thanks — sending your loyalty sign-up now…"));
  sendMessage(`LOYALTY_SIGNUP payload: ${JSON.stringify(payload)}`);

  // Remove the form bubble
  bubble.closest(".msg")?.remove();
}

    });
  } catch (e) {
    addMsg("assistant", mdToHtml(`**Sorry — couldn't load the form.**\n\n${e.message}`));
  }
}


/* ====== Networking (proxy wrappers) ====== */
function headerBag(h){ return {'apim-request-id': h.get('apim-request-id')||h.get('x-apim-request-id')||null,'x-ms-request-id': h.get('x-ms-request-id')||null,'x-ms-correlation-request-id': h.get('x-ms-correlation-request-id')||null}; }
async function fetchJSON(url, opts = {}, tag='req') {
  const started = performance.now(); log(`➡️ ${tag.toUpperCase()} ${url}`);
  let res, text; try { res = await fetch(url, opts); } catch (e) { log(`❌ Network error: ${e.message||e}`); throw e; }
  log(`⬅️ ${tag.toUpperCase()} status=${res.status} ${res.statusText} (${Math.round(performance.now()-started)} ms) headers=${JSON.stringify(headerBag(res.headers))}`);
  try { text = await res.text(); } catch (e) { log(`⚠️ read body failed: ${e.message||e}`); throw e; }
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  log(`📦 ${tag.toUpperCase()} body: ${(text && text.length>2000)? text.slice(0,2000)+'…' : (text||'(empty)')}`);
  if (!res.ok) { const msg = data?.error?.message || data?.message || res.statusText; const err = new Error(msg); err.status = res.status; err.response = data; throw err; }
  return data;
}
async function createThreadAndRun(firstText) {
  const payload = { assistant_id: ASSISTANT_ID, thread: { messages: [{ role: "user", content: firstText }] } };
  return fetchJSON(`${PROXY_BASE}/threads-runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectEndpoint: PROJECT_ENDPOINT, payload }) }, "threads-runs");
}
async function appendMessage(text) {
  return fetchJSON(`${PROXY_BASE}/append-message`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ projectEndpoint: PROJECT_ENDPOINT, threadId, role:"user", content: text }) }, "append-message");
}
async function startRun() {
  return fetchJSON(`${PROXY_BASE}/start-run`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ projectEndpoint: PROJECT_ENDPOINT, threadId, assistantId: ASSISTANT_ID }) }, "start-run");
}
async function getRun(runId) {
  return fetchJSON(`${PROXY_BASE}/run-status?` + new URLSearchParams({ projectEndpoint: PROJECT_ENDPOINT, threadId, runId }), {}, "run-status");
}
async function listThreadMessages() {
  return fetchJSON(`${PROXY_BASE}/messages?` + new URLSearchParams({ projectEndpoint: PROJECT_ENDPOINT, threadId }), {}, "messages");
}

/* ====== Chat flow ====== */
function shouldSkipUserBubble(text) {
  return /Where is my order\?/i.test(text)
      || /Cycle\s*to\s*Work status/i.test(text)
      || /^LOYALTY_SIGNUP\b/i.test(text)   // ← add this
      || /^FEEDBACK\s*[1-5]\b/i.test(text);
}

async function sendMessage(text) {
  if (!text.trim() || sending) return;
  sending = true; const $send = el("send"); const $userText = el("userText");
  if ($send) $send.disabled = true; if ($userText) $userText.disabled = true;

  if (!shouldSkipUserBubble(text)) addMsg("user", mdToHtml(text));
  showTyping();

  try {
    let runId, status;
    if (!threadId) {
      const { thread, run } = await createThreadAndRun(text);
      threadId = thread?.id || run?.thread_id; runId = run?.id; status = run?.status;
    } else {
      await appendMessage(text);
      const run = await startRun();
      runId = run?.id; status = run?.status;
    }

    const terminal = new Set(["completed","failed","cancelled","expired"]);
    while (!terminal.has(status)) {
      await new Promise(r => setTimeout(r, 1200));
      const rstatus = await getRun(runId);
      status = rstatus?.status;
      if (status === "requires_action") break; // tool-calls not streamed in this UI
    }

    const list = await listThreadMessages();
    hideTyping();
    renderLatestAssistant(list);
  } catch (e) {
    hideTyping();
    addMsg("assistant", mdToHtml(`**Sorry — I hit an error:**\n\n${e.message || String(e)}`));
  } finally {
    sending = false; if ($send) $send.disabled = false; if ($userText) { $userText.disabled = false; $userText.focus(); }
  }
}



/* ====== Feedback: strip prompt + show stars ====== */
// Remove the literal "FEEDBACK 1 to 5" line(s) from assistant text
function stripFeedbackPrompt(text = "") {
  let found = false;

  
  // remove whole lines/sentences that contain the phrase
  let cleaned = text.replace(
    /(^|\n)[^\n]*\bfeedback\s*1\s*(?:-|–|to)\s*5\b[^\n]*([.!?])?(?=\n|$)/gi,
    () => { found = true; return ""; }
  );

  // fallback – remove any bare occurrences left
  cleaned = cleaned.replace(
    /\bfeedback\s*1\s*(?:-|–|to)\s*5\b/gi,
    () => { found = true; return ""; }
  );

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { cleaned, found };
}

function renderLatestAssistant(itemsParam) {
  const items = Array.isArray(itemsParam) ? itemsParam : (itemsParam?.data || []);
  if (!items.length) { addMsg("assistant", mdToHtml("_No messages returned._")); return; }

  const sorted = items[0]?.created_at ? items.slice().sort((a,b)=> (b.created_at||0) - (a.created_at||0)) : items;
  const latestAssistant = sorted.find(m => String(m.role || "").toLowerCase() === "assistant");
  if (!latestAssistant) { addMsg("assistant", mdToHtml("_No assistant response found._")); return; }

  try { log("ℹ️ latest assistant message:", JSON.stringify(latestAssistant).slice(0, 2000)); } catch {}


  
  const raw = extractAssistantText(latestAssistant) || "";
  const { cleaned, found } = stripFeedbackPrompt(raw);

  if (cleaned) addMsg("assistant", mdToHtml(cleaned));
  if (found && !pendingFeedback) { pendingFeedback = true; renderFeedbackPrompt(); }
}

function renderFeedbackPrompt() {
  const html = `
    <form id="feedback-form" class="mini-form" aria-label="Provide feedback 1 to 5">
      <strong>How was this answer?</strong>
      <div class="rating" role="group" aria-label="Rate 1 to 5">
        ${[1,2,3,4,5].map(n =>
          `<button type="button" class="star" data-val="${n}" aria-label="${n} star${n>1?'s':''}" title="${n}">★</button>`
        ).join("")}
      </div>
      <div class="mini-hint">Tap a star (1 = poor, 5 = excellent)</div>
    </form>`;
  const bubble = addMsg("assistant", html);

  const form = bubble.querySelector("#feedback-form");
  const stars = Array.from(form.querySelectorAll(".star"));
  let selected = 0;

  const paint = (n, hover=false) => {
    stars.forEach((btn,i)=>{
      const idx = i+1;
      btn.classList.toggle("active", idx <= n);
      btn.classList.toggle("hover", hover && idx <= n);
    });
  };

  stars.forEach((btn,i)=>{
    const val = i+1;
    btn.addEventListener("mouseenter", ()=>paint(val,true));
    btn.addEventListener("mouseleave", ()=>paint(selected,false));
    btn.addEventListener("focus", ()=>paint(val,true));
    btn.addEventListener("blur", ()=>paint(selected,false));
    btn.addEventListener("click", async ()=>{
      selected = val; paint(selected,false);
      addMsg("user", mdToHtml(`Feedback: ${"★".repeat(selected)}${"☆".repeat(5-selected)} (${selected}/5)`));
      await sendMessage(`FEEDBACK ${selected}`);
      form.closest(".msg")?.remove();
      pendingFeedback = false;
    });
  });
}

/* ====== Events & boot ====== */
// Composer (free text)
const $composer = el("composer");
if ($composer) {
  $composer.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const $userText = el("userText");
    const txt = ($userText?.value || "");
    if ($userText) $userText.value = "";
    sendMessage(txt);
  });
}
const $userText = el("userText");
if ($userText) {
  $userText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const $send = el("send"); if ($send) $send.click(); }
  });
}

// Quick action chips inside bubbles
$messages.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const action = chip.dataset.action;
  const prompt = chip.dataset.prompt || chip.textContent.trim();
  if (action === "wimo")      return void renderFormFragment("track-order");
  if (action === "c2w")       return void renderFormFragment("c2w-status");
  if (action === "loyalty")   return void renderFormFragment("loyalty-signup");
  return void sendMessage(prompt);
});
$messages.addEventListener("keydown", (e) => {
  const chip = e.target.closest(".chip"); if (!chip) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const action = chip.dataset.action;
    const prompt = chip.dataset.prompt || chip.textContent.trim();
    if (action === "wimo")   return void renderFormFragment("track-order");
    if (action === "c2w")    return void renderFormFragment("c2w-status");
    if (action === "loyaltly")   return void renderFormFragment("loyalty-signup"); 
    return void sendMessage(prompt);
  }
});

// New chat (optional button)
const $newChat = el("newChat");
if ($newChat) {
  $newChat.addEventListener("click", () => {
    threadId = null;
    $messages.innerHTML = `
      <div class="msg assistant">
        <div class="avatar h">H</div>
        <div>
          <div class="meta">Assistant · fresh thread</div>
          <div class="bubble">
            New chat started. How can I help?
            <div class="quick-wrap">
              <div class="muted" style="margin-bottom:6px;">Quick actions</div>
              <div class="quick">
                ${SUGGESTIONS.map(s =>
                  `<span class="chip" role="button" tabindex="0" ${s.action ? `data-action="${s.action}"` : `data-prompt="${s.prompt}"`}>${s.label}</span>`
                ).join("")}
              </div>
            </div>
          </div>
        </div>
      </div>`;
    // re-attach sentinel
    $bottom = document.createElement("div"); $bottom.id = "bottomSentinel"; $bottom.style.cssText = "height:1px;"; $messages.appendChild($bottom);
    if ($log) $log.textContent = "";
    ping();
    ensureBottomSoon({ smooth: false });
  });
}

// Ping proxy on load
async function ping() {
  try {
    const r = await fetch(`${PROXY_BASE}/ping`);
    if ($status) {
      if (r.ok) { $status.textContent = "Connected"; $status.classList.remove("muted"); }
      else { $status.textContent = "Proxy issue"; $status.classList.add("muted"); }
    }
  } catch {
    if ($status) { $status.textContent = "Offline"; $status.classList.add("muted"); }
  }
}
log(`Client using PROXY_BASE = ${PROXY_BASE}`);
ping();
ensureBottomSoon({ smooth: false });
