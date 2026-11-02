import express from "express";
import crypto from "node:crypto";
import { RULES } from "./rules.js";

const {
  PORT = 3000,
  VERIFY_TOKEN,          // أي كلمة سر تختارها، نفسها تكتبها بإعدادات الـ webhook بـ Meta
  APP_SECRET,            // المفتاح السري للتطبيق: إعدادات التطبيق ← أساسي
  IG_ACCESS_TOKEN,       // التوكن اللي طلّعته من "إنشاء رموز الوصول"
  IG_USER_ID,            // رقم حسابك الاحترافي على انستا
  GRAPH_VERSION = "v23.0",
  GRAPH_HOST = "graph.facebook.com", // التطبيقات الجديدة (تسجيل الدخول الموحّد) تستخدم هذا
  DRY_RUN = "false",     // true = يطبع بس وما يرسل (للتجربة)
  POLL_SECONDS = "30",   // كل كم ثانية يفحص التعليقات الجديدة (0 = يطفي الفحص ويعتمد على الـ webhook بس)
  POLL_MEDIA = "10",     // كم آخر بوست/ريل يفحص
  LOOKBACK_MINUTES = "30", // وقت ما يشتغل السيرفر، يرد على التعليقات من آخر كم دقيقة
  RENDER_EXTERNAL_URL,   // Render يحطه وحده — نستخدمه حتى السيرفر ما ينام
} = process.env;

const dryRun = DRY_RUN === "true";

if (!dryRun) {
  for (const [k, v] of Object.entries({ VERIFY_TOKEN, APP_SECRET, IG_ACCESS_TOKEN, IG_USER_ID })) {
    if (!v) {
      console.error(`ناقص المتغير ${k} — شوف ملف .env.example`);
      process.exit(1);
    }
  }
}

// ---------- توحيد الكتابة العربية حتى "رقم" و "رقٌم" و "الرقم" تنطابق ----------
export function normalize(text = "") {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // التشكيل والتطويل
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")           // نشيل الرموز والإيموجي
    .replace(/\s+/g, " ")
    .trim();
}

export function findRule(commentText, mediaId) {
  const words = normalize(commentText).split(" ");
  return RULES.find((rule) => {
    if (rule.mediaIds?.length && !rule.mediaIds.includes(mediaId)) return false;
    return rule.keywords.some((kw) => words.includes(normalize(kw)));
  });
}

// ---------- منع الإرسال مرتين لنفس التعليق ----------
const handled = new Set();
function markHandled(id) {
  if (handled.has(id)) return false;
  handled.add(id);
  if (handled.size > 5000) handled.delete(handled.values().next().value);
  return true;
}

// ---------- طلبات API انستغرام ----------
async function igPost(path, body) {
  if (dryRun) {
    console.log("[DRY_RUN] POST", path, JSON.stringify(body));
    return { ok: true };
  }
  const res = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function sendPrivateReply(commentId, text) {
  return igPost(`${igId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text },
  });
}

async function replyPublicly(commentId, text) {
  return igPost(`${commentId}/replies`, { message: text });
}

export let igGet = async (path, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${path}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data;
};
export function setIgGet(fn) { igGet = fn; } // للتجربة

let ownUsername = null;
let igId = IG_USER_ID; // ممكن يتغير إذا اكتشفنا الرقم الصحيح للحساب

// ---------- معالجة تعليق واحد ----------
export async function handleComment(value, ownerId) {
  const commentId = value?.id;
  const text = value?.text ?? "";
  const fromId = value?.from?.id;
  const mediaId = value?.media?.id;

  if (!commentId) return;
  if (fromId && (fromId === ownerId || fromId === IG_USER_ID || fromId === igId)) return; // تعليقاتك انت
  if (ownUsername && value?.from?.username === ownUsername) return;
  const rule = findRule(text, mediaId);
  if (!rule) {
    console.log(`  تعليق "${text}" ما بيه كلمة من الكلمات (البوست ${mediaId})`);
    return;
  }
  if (!markHandled(commentId)) return;

  console.log(`تعليق مطابق من @${value?.from?.username ?? "?"}: "${text}"`);

  try {
    await sendPrivateReply(commentId, rule.message);
    console.log("  ✓ انرسلت الرسالة الخاصة");
  } catch (err) {
    console.error("  ✗ فشل الإرسال الخاص:", err.message);
    return;
  }

  if (rule.publicReply) {
    try {
      await replyPublicly(commentId, rule.publicReply);
      console.log("  ✓ انكتب الرد العلني");
    } catch (err) {
      console.error("  ✗ فشل الرد العلني:", err.message);
    }
  }
}

// ---------- السيرفر ----------
const app = express();

// نحتاج النص الخام حتى نتحقق من توقيع Meta
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function validSignature(req) {
  if (dryRun) return true;
  const header = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  return header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

app.get("/", (_req, res) => res.send("insta-auto-dm شغّال ✅"));

// سياسة الخصوصية (Meta تطلب رابطها حتى تنشر التطبيق)
app.get("/privacy", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>سياسة الخصوصية</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.8}</style></head><body>
<h1>سياسة الخصوصية</h1>
<p>هذه الأداة ترسل رسالة خاصة تلقائية على Instagram لمن يعلّق بكلمة معيّنة على منشورات حسابنا.</p>
<p>البيانات المستخدمة: معرّف التعليق ونصّه واسم المستخدم، فقط لغرض إرسال الرد. لا نخزّن هذه البيانات ولا نبيعها ولا نشاركها مع أي جهة.</p>
<p>حذف البيانات: لا نحتفظ بأي بيانات. للاستفسار راسلنا على Instagram.</p>
</body></html>`);
});

// تحقق Meta من الرابط (مرة وحدة وقت تضيف الـ webhook)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// الإشعارات
app.post("/webhook", (req, res) => {
  if (!validSignature(req)) {
    console.error("✗ وصل إشعار بس التوقيع غلط — تأكد إن APP_SECRET هو المفتاح السري لنفس التطبيق");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // نرد بسرعة حتى Meta ما تعيد الإرسال
  console.log("📩 وصل إشعار من Meta:", JSON.stringify(req.body).slice(0, 500));

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        handleComment(change.value, entry.id).catch((e) => console.error(e));
      }
    }
  }
});

// ---------- فحص التعليقات الجديدة بشكل دوري ----------
// Meta ما تدز إشعارات التعليقات الحقيقية إلا إذا التطبيق عنده "وصول متقدم" (يحتاج مراجعة وتوثيق تجاري).
// فبدالها السيرفر نفسه يسأل انستغرام كل شوية: شنو التعليقات الجديدة على آخر البوستات؟
const seen = new Set();
let since = Date.now() - Number(LOOKBACK_MINUTES) * 60_000;

export async function pollOnce() {
  const data = await igGet(`${igId}/media`, {
    fields: "id,comments.limit(50){id,text,timestamp,username,from}",
    limit: String(POLL_MEDIA),
  });
  for (const media of data.data ?? []) {
    for (const c of media.comments?.data ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (seen.size > 20000) seen.delete(seen.values().next().value);
      const t = Date.parse(String(c.timestamp).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
      if (Number.isFinite(t) && t < since) continue; // تعليق قديم
      await handleComment({
        id: c.id,
        text: c.text,
        from: { id: c.from?.id, username: c.from?.username ?? c.username },
        media: { id: media.id },
      }, igId);
    }
  }
}

// نتأكد إن التوكن يوصل للحساب، وإذا الرقم غلط نحاول نلكى الرقم الصحيح وحده
async function findAccount() {
  try {
    const me = await igGet(igId, { fields: "username" });
    ownUsername = me.username;
    console.log(`✓ التوكن شغّال — الحساب: @${ownUsername} (${igId})`);
    return;
  } catch (e) {
    console.error(`✗ التوكن ما يوصل للرقم ${igId}:`, e.message.slice(0, 200));
  }
  const tries = [
    ["me", { fields: "id,name" }],
    ["me/accounts", { fields: "name,instagram_business_account{id,username}" }],
    ["me/instagram_accounts", { fields: "id,username" }],
  ];
  for (const [path, params] of tries) {
    try {
      const r = await igGet(path, params);
      console.log(`🔍 ${path}:`, JSON.stringify(r).slice(0, 400));
      const found =
        r.data?.find((p) => p.instagram_business_account)?.instagram_business_account ||
        (path === "me/instagram_accounts" ? r.data?.[0] : null);
      if (found?.id) {
        igId = found.id;
        ownUsername = found.username ?? null;
        console.log(`✓ لكيت رقم الحساب الصحيح: ${igId} (@${ownUsername}) — حطه بـ IG_USER_ID`);
        return;
      }
    } catch (e) {
      console.log(`🔍 ${path}: ✗`, e.message.slice(0, 200));
    }
  }
  console.error("✗ التوكن ما يوصل لأي حساب انستغرام — لازم تختار حساب raqeem_1 وقت تطلّع التوكن");
}

async function startPolling() {
  const every = Number(POLL_SECONDS);
  if (!every) return;
  await findAccount();
  // نحاول نشغّل اشتراك الـ webhook للحساب (إذا صار عنده وصول متقدم بعدين يشتغل وحده)
  try {
    await igPost(`${igId}/subscribed_apps?subscribed_fields=comments`, {});
  } catch (e) {
    console.log("ملاحظة: اشتراك الـ webhook للحساب:", e.message.slice(0, 200));
  }
  console.log(`🔎 يفحص التعليقات الجديدة كل ${every} ثانية على آخر ${POLL_MEDIA} بوستات`);
  const tick = async () => {
    try { await pollOnce(); }
    catch (e) { console.error("✗ خطأ بفحص التعليقات:", e.message.slice(0, 300)); }
    setTimeout(tick, every * 1000);
  };
  tick();
}

// النسخة المجانية من Render تنام إذا ما أحد زارها 15 دقيقة، فنزورها كل 10 دقايق
function keepAwake() {
  if (!RENDER_EXTERNAL_URL) return;
  setInterval(() => fetch(RENDER_EXTERNAL_URL).catch(() => {}), 10 * 60_000);
}

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`السيرفر شغّال على البورت ${PORT}${dryRun ? " (DRY_RUN)" : ""}`);
    if (!dryRun) { startPolling(); keepAwake(); }
  });
}

export default app;
