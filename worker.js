// Сервер для «Дневника похудения» — Cloudflare Worker.
// Что делает: проверяет, что запрос пришёл из Telegram; бот присылает напоминания и сводки;
// распознаёт еду по фото через Claude; ведёт семейную группу; ходит в базу продуктов (без VPN);
// отдаёт файлы (календарь, таблица, картинка).
//
// Разворачивается из GitHub (Workers Builds) по файлу wrangler.jsonc — хранилище, расписание
// и адрес приложения описаны там. В настройках воркера нужно добавить только два секрета:
//   BOT_TOKEN, ANTHROPIC_API_KEY

import { DurableObject } from "cloudflare:workers";

/* Хранилище: Durable Object с SQLite (бесплатно, не требует ручной настройки) */
export class DnevnikStore extends DurableObject {
  async kget(k) {
    const r = await this.ctx.storage.get(k);
    if (!r) return null;
    if (r.exp && r.exp < Date.now()) { await this.ctx.storage.delete(k); return null; }
    return r.v;
  }
  async kput(k, v, ttl) { await this.ctx.storage.put(k, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); }
  async kdel(k) { await this.ctx.storage.delete(k); }
  async klist(prefix) {
    const m = await this.ctx.storage.list({ prefix }), out = [], now = Date.now();
    for (const [k, r] of m) { if (r && (!r.exp || r.exp >= now)) out.push([k, r.v]); }
    return out;
  }
  async kputMany(entries) { const o = {}; for (const [k, v] of entries) o[k] = { v, exp: 0 }; await this.ctx.storage.put(o); }
}
function storeKV(env) {
  if (env.KV) {
    const kv = env.KV;
    return {
      get: (k, t) => kv.get(k, t), put: (k, v, o) => kv.put(k, v, o), delete: k => kv.delete(k),
      async listPrefix(prefix) { const out = []; let cursor; do { const r = await kv.list({ prefix, cursor }); for (const x of r.keys) out.push([x.name, await kv.get(x.name)]); cursor = r.list_complete ? null : r.cursor; } while (cursor); return out; },
      async putMany(entries) { for (const [k, v] of entries) await kv.put(k, String(v)); },
    };
  }                       // если подключено обычное KV — используем его
  const stub = () => env.STORE.get(env.STORE.idFromName("main"));
  return {
    async get(k, type) { const v = await stub().kget(k); if (v == null) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v, opts) { await stub().kput(k, String(v), opts && opts.expirationTtl); },
    async delete(k) { await stub().kdel(k); },
    async listPrefix(prefix) { return await stub().klist(prefix); },
    async putMany(entries) { await stub().kputMany(entries.map(([k, v]) => [k, String(v)])); },
  };
}

const MODEL_MAIN = "claude-haiku-5-5";
const MODEL_FALLBACK = "claude-sonnet-5-5";
const AI_DAILY_LIMIT = 60;          // фото в день на человека
const OFF = "https://world.openfoodfacts.org";
const OFF_FIELDS = "code,product_name,product_name_ru,brands,quantity,nutriments,countries_tags";

export default {
  async fetch(req, env, ctx) {
    env = { ...env, KV: storeKV(env) };
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);
    try {
      if (url.pathname === "/") return text("Сервер дневника работает ✅");
      if (url.pathname === "/setup") return await setup(req, env, url);
      if (url.pathname === "/tg" && req.method === "POST") return await onTelegram(req, env, ctx);
      if (url.pathname.startsWith("/f/")) return await serveFile(env, url);
      if (url.pathname === "/h") return await healthIn(req, env, url);
      if (url.pathname === "/api/login/start") return cors(await loginStart(env), req);
      if (url.pathname === "/api/login/check") return cors(await loginCheck(env, url), req);
      if (url.pathname.startsWith("/api/")) {
        const user = await auth(req, env);
        if (!user) return cors(json({ error: "auth" }, 401), req);
        const res = await api(req, env, url, user, ctx);
        return cors(res, req);
      }
      return text("Не найдено", 404);
    } catch (e) {
      return cors(json({ error: String(e && e.message || e) }, 500), req);
    }
  },
  async scheduled(event, env, ctx) {
    env = { ...env, KV: storeKV(env) };
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },
};

/* ---------------- утилиты ---------------- */
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const text = (t, status = 200) => new Response(t, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
function cors(res, req) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", req.headers.get("origin") || "*");
  h.set("access-control-allow-headers", "content-type, x-tg-init, x-session");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-max-age", "86400");
  return new Response(res.body, { status: res.status, headers: h });
}
const enc = new TextEncoder();
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
async function sha(s) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }
const rid = (n = 10) => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(n)); for (const x of r) s += a[x % a.length]; return s; };
const kget = async (env, k, d = null) => { const v = await env.KV.get(k, "json"); return v == null ? d : v; };
const kput = (env, k, v, ttl) => env.KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);

/* проверка подписи Telegram (initData) */
async function auth(req, env) {
  const sess = req.headers.get("x-session") || "";
  if (sess) { const u = await kget(env, `sess:${sess}`); return u ? { id: String(u.id), name: u.name, session: sess } : null; }
  const init = req.headers.get("x-tg-init") || "";
  if (!init) return null;
  const p = new URLSearchParams(init);
  const hash = p.get("hash"); if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", env.BOT_TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const authDate = +p.get("auth_date") || 0;
  if (Date.now() / 1000 - authDate > 60 * 60 * 24 * 60) return null; // сессия не старше 60 дней
  let u = {}; try { u = JSON.parse(p.get("user") || "{}"); } catch (e) {}
  if (!u.id) return null;
  return { id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Без имени" };
}

/* ---------------- вход в отдельном приложении через бота ---------------- */
async function loginStart(env) {
  const nonce = rid(24), bot = await botUsername(env);
  await kput(env, `ln:${nonce}`, { st: "wait" }, 60 * 15);
  return json({ nonce, link: `https://t.me/${bot}?start=login_${nonce}` });
}
async function loginCheck(env, url) {
  const nonce = String(url.searchParams.get("nonce") || "").replace(/[^a-z0-9]/g, "");
  const r = nonce ? await kget(env, `ln:${nonce}`) : null;
  if (!r) return json({ status: "expired" });
  if (!r.uid) return json({ status: "wait" });
  const token = rid(32);
  await kput(env, `sess:${token}`, { id: r.uid, name: r.name }, 60 * 60 * 24 * 365);
  await env.KV.delete(`ln:${nonce}`);
  return json({ status: "ok", token, user: { id: r.uid, name: r.name } });
}

/* ---------------- Telegram Bot API ---------------- */
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const openBtn = (env, label = "Открыть дневник") => ({ inline_keyboard: [[{ text: label, web_app: { url: env.APP_URL } }]] });
async function botUsername(env) {
  let u = await env.KV.get("bot:username");
  if (!u) { const me = await tg(env, "getMe", {}); u = me.result && me.result.username; if (u) await env.KV.put("bot:username", u); }
  return u;
}
async function send(env, chatId, msg, extra = {}) {
  const r = await tg(env, "sendMessage", { chat_id: chatId, text: msg, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  return r.ok;
}

async function setup(req, env, url) {
  if (url.searchParams.get("token") !== env.BOT_TOKEN) return text("Добавь в адрес ?token=ТОКЕН_БОТА", 403);
  const secret = (await sha("hook" + env.BOT_TOKEN)).slice(0, 40);
  const hook = await tg(env, "setWebhook", { url: `${url.origin}/tg`, secret_token: secret, allowed_updates: ["message"] });
  await tg(env, "setMyCommands", { commands: [
    { command: "start", description: "Начать" },
    { command: "today", description: "Итог сегодняшнего дня" },
    { command: "week", description: "Отчёт за неделю" },
    { command: "stop", description: "Выключить напоминания" },
  ] });
  await botUsername(env);
  const okModel = env.ANTHROPIC_API_KEY ? "есть" : "НЕТ — фото еды работать не будет";
  return text(`Готово.\nВебхук: ${hook.ok ? "подключён ✅" : "ошибка: " + JSON.stringify(hook)}\nКлюч ИИ: ${okModel}\nХранилище: ${env.KV ? "подключено ✅" : "НЕТ"}\nAPP_URL: ${env.APP_URL || "НЕ ЗАДАН"}`);
}

async function onTelegram(req, env, ctx) {
  const secret = (await sha("hook" + env.BOT_TOKEN)).slice(0, 40);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return text("no", 403);
  const upd = await req.json();
  const m = upd.message; if (!m || !m.text) return text("ok");
  const uid = String(m.from.id), cmd = m.text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd === "/start") {
    const arg = m.text.trim().split(/\s+/)[1] || "";
    if (arg.startsWith("login_")) {
      const nonce = arg.slice(6).replace(/[^a-z0-9]/g, ""), r = await kget(env, `ln:${nonce}`);
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "Без имени";
      if (!r) { await send(env, uid, "Ссылка для входа устарела. Нажми «Войти через Telegram» в приложении ещё раз."); return text("ok"); }
      await ensureUser(env, uid, m.from.first_name || "");
      await kput(env, `ln:${nonce}`, { st: "ok", uid, name }, 60 * 15);
      await send(env, uid, "✅ Вход выполнен! Возвращайся в приложение «Дневник» — твои записи уже подтягиваются.");
      return text("ok");
    }
    await ensureUser(env, uid, m.from.first_name || "");
    await botDescribe(env);
    await send(env, uid, introText(m.from.first_name), { reply_markup: openBtn(env, "Открыть дневник 🌿") });
  } else if (cmd === "/today") {
    const s = await userSettings(env, uid);
    await send(env, uid, await dayText(env, uid, localDate(new Date(), s.tz)), { reply_markup: openBtn(env) });
  } else if (cmd === "/week") {
    const s = await userSettings(env, uid);
    await send(env, uid, await weekText(env, uid, localDate(new Date(), s.tz)), { reply_markup: openBtn(env) });
  } else if (cmd === "/stop") {
    const s = await userSettings(env, uid); s.log.on = false; s.summary.on = false; s.weigh.on = false; s.weekly.on = false;
    await kput(env, `s:${uid}`, s);
    await send(env, uid, "Напоминания выключены. Включить снова — в приложении: «Профиль» → «Напоминания бота».");
  } else {
    await send(env, uid, "Я понимаю команды /today, /week и /stop. А всё остальное — в приложении 👇", { reply_markup: openBtn(env) });
  }
  return text("ok");
}

/* ---------------- вступление бота ---------------- */
const BOT_DESC = "Дневник похудения 🌿\n\n🍽 Считает калории и БЖУ: пишешь продукт и граммы — остальное посчитается само\n📷 Еда по фото, штрихкоду и этикетке\n📅 Меню на неделю и список покупок\n⚖️ Вес, прогресс и прогноз до цели\n❤️ Шаги и активность из «Здоровья» на iPhone\n👨‍👩‍👧 Общее меню для семьи\n🔔 Напоминания и итоги дня и недели\n\nНажми «Старт» — и начнём.";
const BOT_SHORT = "Считаю калории по продукту и граммам, фото и штрихкоду. Меню на неделю, вес, шаги и напоминания 🌿";
async function botDescribe(env) {
  if (await env.KV.get("desc:v1")) return;
  await tg(env, "setMyDescription", { description: BOT_DESC });
  await tg(env, "setMyShortDescription", { short_description: BOT_SHORT });
  await env.KV.put("desc:v1", "1");
}
function introText(name) {
  return `Привет${name ? ", " + esc(name) : ""}! 🌿 Я — <b>Дневник похудения</b>.

Вот что я умею:
🍽 <b>Считаю калории и БЖУ</b> — пишешь продукт и граммы, остальное посчитается само
📷 <b>Еда по фото</b>, штрихкоду и этикетке
📅 <b>Меню на неделю</b>, идеи блюд из того, что есть дома, и список покупок
⚖️ <b>Вес и прогресс</b> — графики и прогноз, когда дойдёшь до цели
❤️ <b>Шаги из «Здоровья»</b> на iPhone
👨‍👩‍👧 <b>Семья</b> — общее меню и покупки
🔔 <b>Напоминаю</b> записать еду и присылаю итоги дня и недели

<b>С чего начать — 3 шага:</b>
1️⃣ Нажми «Открыть дневник» ниже
2️⃣ Заполни <b>профиль</b>: пол, возраст, рост, вес и цель — и нажми «Сохранить профиль». Без него я не посчитаю твою норму калорий
3️⃣ Записывай еду — остальное посчитается само. В каждом разделе будут подсказки

Команды: /today — итог дня, /week — отчёт за неделю, /stop — выключить напоминания.`;
}

/* ---------------- пользователи и настройки ---------------- */
const DEFAULT_SETTINGS = {
  tz: 180,
  log: { on: true, times: ["13:30", "20:30"] },
  summary: { on: true, time: "21:30" },
  weigh: { on: true, day: 1, time: "08:30" },  // 1 = понедельник
  weekly: { on: true, time: "20:00" },          // по воскресеньям
};
async function ensureUser(env, uid, name) {
  const list = await kget(env, "users", []);
  if (!list.includes(uid)) { list.push(uid); await kput(env, "users", list); }
  if (name) await env.KV.put(`n:${uid}`, name);
}
async function userSettings(env, uid) {
  const s = await kget(env, `s:${uid}`, null);
  return s ? { ...DEFAULT_SETTINGS, ...s, log: { ...DEFAULT_SETTINGS.log, ...(s.log || {}) }, summary: { ...DEFAULT_SETTINGS.summary, ...(s.summary || {}) }, weigh: { ...DEFAULT_SETTINGS.weigh, ...(s.weigh || {}) }, weekly: { ...DEFAULT_SETTINGS.weekly, ...(s.weekly || {}) } } : { ...DEFAULT_SETTINGS };
}
function localNow(d, tz) { return new Date(d.getTime() + tz * 60000); }
function localDate(d, tz) { return localNow(d, tz).toISOString().slice(0, 10); }
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = n => Math.round(n).toLocaleString("ru-RU");
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString("ru-RU");

/* ---------------- API для приложения ---------------- */
async function api(req, env, url, user, ctx) {
  const p = url.pathname.slice(5), body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  if (p === "hello") {
    await ensureUser(env, user.id, user.name);
    const s = await userSettings(env, user.id);
    if (typeof body.tz === "number" && body.tz !== s.tz) { s.tz = body.tz; await kput(env, `s:${user.id}`, s); }
    return json({ ok: true, settings: s, ai: !!env.ANTHROPIC_API_KEY, family: await env.KV.get(`uf:${user.id}`) });
  }
  if (p === "settings") {
    if (req.method === "POST") { const s = { ...(await userSettings(env, user.id)), ...body }; await kput(env, `s:${user.id}`, s); return json({ ok: true, settings: s }); }
    return json({ settings: await userSettings(env, user.id) });
  }
  if (p === "day") {   // сводка дня для напоминаний и отчётов
    if (!body.date) return json({ error: "date" }, 400);
    await kput(env, `d:${user.id}:${body.date}`, { kcal: body.kcal || 0, norm: body.norm || 0, p: body.p || 0, f: body.f || 0, c: body.c || 0, burn: body.burn || 0, n: body.n || 0, steps: body.steps || 0, w: body.w || null }, 60 * 60 * 24 * 45);
    return json({ ok: true });
  }
  if (p === "data" && req.method === "GET") {
    const pre = `u:${user.id}:d:`, rows = await env.KV.listPrefix(pre), docs = {};
    for (const [k, v] of rows) { try { docs[k.slice(pre.length)] = JSON.parse(v); } catch (e) {} }
    return json({ docs, me: { id: user.id, name: user.name }, health: await kget(env, `hp:${user.id}`) });
  }
  if (p === "data") {   // {docs:{key:{v,at}}} — побеждает более свежая запись
    const pre = `u:${user.id}:d:`, incoming = body.docs || {}, keys = Object.keys(incoming).filter(k => /^[A-Za-z0-9_\-]{1,64}$/.test(k)).slice(0, 400);
    const cur = {}; for (const [k, v] of await env.KV.listPrefix(pre)) { try { cur[k.slice(pre.length)] = JSON.parse(v); } catch (e) {} }
    const write = [], accepted = {}, newer = {};
    for (const k of keys) {
      const d = incoming[k]; if (!d || typeof d.at !== "number") continue;
      const size = JSON.stringify(d).length; if (size > 1_500_000) continue;
      if (!cur[k] || d.at > (cur[k].at || 0)) { write.push([pre + k, JSON.stringify({ v: d.v === undefined ? null : d.v, at: d.at })]); accepted[k] = d.at; }
      else if (cur[k].at > d.at) newer[k] = cur[k];
    }
    if (write.length) await env.KV.putMany(write);
    return json({ ok: true, accepted, newer });
  }
  if (p === "health/key") {   // личный ключ для быстрой команды «Здоровье»
    let k = await env.KV.get(`uhk:${user.id}`);
    if (!k) { k = rid(20); await env.KV.put(`hk:${k}`, user.id); await env.KV.put(`uhk:${user.id}`, k); }
    return json({ key: k });
  }
  if (p === "logout") { if (user.session) await env.KV.delete(`sess:${user.session}`); return json({ ok: true }); }
  if (p === "ai/photo") return await aiPhoto(env, user, body);
  if (p === "off/search") return await offProxy(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(url.searchParams.get("q") || "")}&page_size=40&langs=ru,en&fields=${OFF_FIELDS}`, ctx);
  if (p.startsWith("off/product/")) return await offProxy(`${OFF}/api/v2/product/${encodeURIComponent(p.slice(12))}.json?fields=${OFF_FIELDS}`, ctx);
  if (p === "file") {
    const id = rid(16), name = String(body.name || "file").replace(/[\\/]/g, "_");
    if ((body.b64 || "").length > 8_000_000) return json({ error: "too big" }, 413);
    await kput(env, `f:${id}`, { name, mime: body.mime || "application/octet-stream", b64: body.b64 || "", inline: !!body.inline }, 60 * 60);
    return json({ url: `${url.origin}/f/${id}/${encodeURIComponent(name)}` });
  }
  if (p === "send-photo") {
    const bytes = Uint8Array.from(atob(body.b64 || ""), c => c.charCodeAt(0));
    const fd = new FormData(); fd.append("chat_id", user.id); fd.append("caption", body.caption || ""); fd.append("photo", new Blob([bytes], { type: "image/png" }), "progress.png");
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd }).then(r => r.json());
    return json({ ok: !!r.ok, error: r.ok ? null : (r.description || "send failed") });
  }
  if (p.startsWith("family")) return await family(env, user, p, body, req);
  return json({ error: "unknown" }, 404);
}

/* ---------------- «Здоровье»: данные от быстрой команды iPhone ---------------- */
const hnum = v => { if (v == null) return 0; const m = String(v).replace(/[\s\u00a0\u202f]/g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : 0; };
async function healthIn(req, env, url) {
  let b = {};
  if (req.method === "POST") { const t = await req.text(); try { b = JSON.parse(t) || {}; } catch (e) { b = Object.fromEntries(new URLSearchParams(t)); } }
  const g = k => (b[k] != null && b[k] !== "") ? b[k] : url.searchParams.get(k);
  const key = String(g("k") || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const uid = key ? await env.KV.get(`hk:${key}`) : null;
  if (!uid) return text("❌ Дневник не узнал тебя. Открой дневник → «Профиль» → «Здоровье» → «Обновить из Здоровья».");
  const s = await userSettings(env, uid), date = localDate(new Date(), s.tz);
  const steps = Math.max(0, Math.round(hnum(g("s")))), active = Math.max(0, Math.round(hnum(g("a"))));
  let w = hnum(g("w")); w = (w > 20 && w < 400) ? Math.round(w * 10) / 10 : null;
  await kput(env, `hp:${uid}`, { date, steps, active, w, at: Date.now() });
  const parts = []; if (steps) parts.push(`${fmt(steps)} шагов`); if (active) parts.push(`${fmt(active)} ккал активности`); if (w) parts.push(`вес ${fmt1(w)} кг`);
  return text(parts.length ? `✅ В дневник: ${parts.join(", ")}` : "⚠️ Из «Здоровья» ничего не пришло. Разреши команде доступ к шагам, энергии и весу: «Настройки» → «Здоровье» → «Доступ к данным».");
}

async function serveFile(env, url) {
  const id = url.pathname.split("/")[2];
  const f = await kget(env, `f:${id}`);
  if (!f) return text("Файл устарел — создай заново в приложении", 404);
  const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
  return new Response(bytes, { headers: {
    "content-type": f.mime,
    "content-disposition": `${f.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "access-control-allow-origin": "*",
  } });
}

async function offProxy(target, ctx) {
  const cache = caches.default, key = new Request(target);
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(target, { headers: { "user-agent": "DnevnikPohudeniya/1.0 (telegram mini app)" } });
    res = new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" } });
    if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/* ---------------- ИИ: еда по фото ---------------- */
const AI_PROMPT = `Ты — нутрициолог. На фото еда. Определи каждый отдельный продукт или блюдо на тарелке, оцени его вес в граммах по виду порции и дай пищевую ценность на 100 г (средние значения для такого продукта в приготовленном виде, как на фото).
Названия — по-русски, коротко и понятно («Гречка варёная», «Куриная грудка жареная», «Салат из огурцов и помидоров с маслом»).
Если на фото упаковка с этикеткой — используй цифры с этикетки.
Ответь ТОЛЬКО JSON без пояснений:
{"items":[{"name":"...","grams":число,"kcal":число,"p":число,"f":число,"c":число}],"note":"одна короткая фраза: что видно и насколько уверена оценка"}
kcal, p, f, c — на 100 г. Если еды на фото нет — верни {"items":[],"note":"..."}`;

async function aiPhoto(env, user, body) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Сервер не настроен для ИИ: нет ключа ANTHROPIC_API_KEY" }, 400);
  const day = new Date().toISOString().slice(0, 10), ck = `ai:${user.id}:${day}`;
  const used = +(await env.KV.get(ck) || 0);
  if (used >= AI_DAILY_LIMIT) return json({ error: `Лимит ${AI_DAILY_LIMIT} фото в день исчерпан` }, 429);
  const img = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!img || img.length > 5_000_000) return json({ error: "Нет фото или оно слишком большое" }, 400);
  const hint = body.hint ? `\nПодсказка от пользователя: ${String(body.hint).slice(0, 300)}` : "";
  const call = model => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: body.mime || "image/jpeg", data: img } },
      { type: "text", text: AI_PROMPT + hint },
    ] }] }),
  });
  let r = await call(env.AI_MODEL || MODEL_MAIN);
  if (!r.ok && (r.status === 400 || r.status === 404)) r = await call(MODEL_FALLBACK);
  const data = await r.json();
  if (!r.ok) return json({ error: (data.error && data.error.message) || ("ИИ ответил ошибкой " + r.status) }, 502);
  await env.KV.put(ck, String(used + 1), { expirationTtl: 60 * 60 * 30 });
  const t = (data.content || []).map(c => c.text || "").join("");
  const m = t.match(/\{[\s\S]*\}/);
  let out = { items: [], note: "" };
  try { out = JSON.parse(m ? m[0] : t); } catch (e) { return json({ error: "Не удалось разобрать ответ ИИ", raw: t.slice(0, 500) }, 502); }
  out.items = (out.items || []).filter(x => x && x.name).map(x => ({ name: String(x.name).slice(0, 80), grams: Math.max(1, Math.round(+x.grams || 100)), kcal: +x.kcal || 0, p: +x.p || 0, f: +x.f || 0, c: +x.c || 0 }));
  return json({ ...out, used: used + 1, limit: AI_DAILY_LIMIT });
}

/* ---------------- семья ---------------- */
async function family(env, user, p, body, req) {
  const code = await env.KV.get(`uf:${user.id}`);
  const load = c => kget(env, `fam:${c}`);
  const save = f => kput(env, `fam:${f.code}`, f);
  if (p === "family" && req.method === "GET") {
    if (!code) return json({ family: null });
    const f = await load(code); if (!f) { await env.KV.delete(`uf:${user.id}`); return json({ family: null }); }
    return json({ family: f, me: user.id, bot: await botUsername(env) });
  }
  if (p === "family/create") {
    if (code) return json({ error: "Ты уже в семье" }, 400);
    let c; do { c = rid(6).toUpperCase(); } while (await env.KV.get(`fam:${c}`));
    const f = { code: c, title: String(body.title || "Наша семья").slice(0, 40), owner: user.id, members: [{ id: user.id, name: user.name }], feed: [], menu: null, shop: {} };
    await save(f); await env.KV.put(`uf:${user.id}`, c);
    return json({ family: f, me: user.id, bot: await botUsername(env) });
  }
  if (p === "family/join") {
    const c = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const f = await load(c); if (!f) return json({ error: "Семья с таким кодом не найдена" }, 404);
    if (!f.members.find(m => m.id === user.id)) {
      f.members.push({ id: user.id, name: user.name }); await save(f);
      for (const m of f.members) if (m.id !== user.id) await send(env, m.id, `👋 <b>${esc(user.name)}</b> присоединился(ась) к семье «${esc(f.title)}»`);
    }
    await env.KV.put(`uf:${user.id}`, c);
    return json({ family: f, me: user.id, bot: await botUsername(env) });
  }
  if (!code) return json({ error: "Ты пока не в семье" }, 400);
  const f = await load(code); if (!f) return json({ error: "Семья не найдена" }, 404);
  if (p === "family/leave") {
    f.members = f.members.filter(m => m.id !== user.id);
    if (!f.members.length) await env.KV.delete(`fam:${code}`); else { if (f.owner === user.id) f.owner = f.members[0].id; await save(f); }
    await env.KV.delete(`uf:${user.id}`);
    return json({ family: null });
  }
  if (p === "family/post") {   // блюдо / приём пищи / меню — в ленту семьи
    const it = { id: rid(8), from: user.id, name: user.name, kind: body.kind, title: String(body.title || "").slice(0, 120), code: String(body.code || ""), kcal: body.kcal || null, at: Date.now() };
    if (!it.code) return json({ error: "code" }, 400);
    f.feed = [it, ...(f.feed || [])].slice(0, 40); await save(f);
    const bot = await botUsername(env);
    const link = it.code.length <= 512 && bot ? `https://t.me/${bot}?startapp=${it.code}` : null;
    for (const m of f.members) if (m.id !== user.id) {
      await send(env, m.id, `🍽 <b>${esc(user.name)}</b> поделился(ась): ${esc(it.title)}${it.kcal ? ` · ${fmt(it.kcal)} ккал` : ""}`, { reply_markup: link ? { inline_keyboard: [[{ text: "Добавить себе", url: link }]] } : openBtn(env) });
    }
    return json({ family: f, me: user.id, bot });
  }
  if (p === "family/menu") {   // общее меню на неделю
    f.menu = body.clear ? null : { wk: body.wk, code: String(body.code || ""), by: user.id, name: user.name, at: Date.now() };
    f.shop = {}; await save(f);
    if (!body.clear) for (const m of f.members) if (m.id !== user.id) await send(env, m.id, `📅 <b>${esc(user.name)}</b> обновил(а) меню семьи на неделю. Открой «Меню» → «Семья», чтобы взять его к себе.`, { reply_markup: openBtn(env) });
    return json({ family: f, me: user.id });
  }
  if (p === "family/shop") {
    f.shop = f.shop || {}; if (body.bought) f.shop[body.key] = user.name; else delete f.shop[body.key];
    await save(f); return json({ family: f, me: user.id });
  }
  return json({ error: "unknown" }, 404);
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ---------------- напоминания и сводки (каждые 30 минут) ---------------- */
async function runCron(env, now) {
  try { await botDescribe(env); } catch (e) {}
  const users = await kget(env, "users", []);
  for (const uid of users) {
    try {
      const s = await userSettings(env, uid);
      const ln = localNow(now, s.tz), hm = `${String(ln.getUTCHours()).padStart(2, "0")}:${ln.getUTCMinutes() < 30 ? "00" : "30"}`;
      const today = ln.toISOString().slice(0, 10), dow = ln.getUTCDay();
      const slot = t => { const [h, m] = String(t).split(":").map(Number); return `${String(h).padStart(2, "0")}:${m < 30 ? "00" : "30"}`; };
      if (s.log.on && (s.log.times || []).some(t => slot(t) === hm)) {
        const d = await kget(env, `d:${uid}:${today}`);
        if (!d || !d.n) await send(env, uid, "🍽 Не забудь записать, что ты сегодня ел(а) — так норма будет считаться точно.", { reply_markup: openBtn(env, "Записать") });
      }
      if (s.summary.on && slot(s.summary.time) === hm) { const d = await kget(env, `d:${uid}:${today}`); if (d && d.n) await send(env, uid, await dayText(env, uid, today), { reply_markup: openBtn(env) }); }
      if (s.weigh.on && dow === +s.weigh.day && slot(s.weigh.time) === hm) await send(env, uid, "⚖️ Доброе утро! Сегодня день взвешивания — встань на весы натощак и запиши вес.", { reply_markup: openBtn(env, "Записать вес") });
      if (s.weekly.on && dow === 0 && slot(s.weekly.time) === hm) { const wt = await weekText(env, uid, today); if (!wt.includes("записей нет")) await send(env, uid, wt, { reply_markup: openBtn(env) }); }
    } catch (e) { /* один пользователь не должен ломать остальных */ }
  }
}
async function dayText(env, uid, date) {
  const d = await kget(env, `d:${uid}:${date}`);
  if (!d || !d.n) return "📋 За сегодня в дневнике пока пусто. Запиши еду — и я посчитаю итог.";
  const left = d.norm ? d.norm + (d.burn || 0) - d.kcal : null;
  const mood = left == null ? "" : left >= 0 ? `✅ Осталось ${fmt(left)} ккал` : `⚠️ Перебор на ${fmt(-left)} ккал`;
  return `📋 <b>Итог дня</b>\nСъедено: <b>${fmt(d.kcal)}</b>${d.norm ? ` из ${fmt(d.norm)}` : ""} ккал\n${mood}\nБ ${fmt(d.p)} · Ж ${fmt(d.f)} · У ${fmt(d.c)} г${d.burn ? `\nСожжено: ${fmt(d.burn)} ккал` : ""}${d.steps ? `\nШаги: ${fmt(d.steps)}` : ""}`;
}
async function weekText(env, uid, date) {
  let sum = 0, days = 0, inNorm = 0, burn = 0, w0 = null, w1 = null;
  for (let i = 6; i >= 0; i--) {
    const d = await kget(env, `d:${uid}:${addDays(date, -i)}`);
    if (!d) continue;
    if (d.n) { sum += d.kcal; days++; if (d.norm && d.kcal <= d.norm + (d.burn || 0)) inNorm++; }
    burn += d.burn || 0;
    if (d.w) { if (w0 == null) w0 = d.w; w1 = d.w; }
  }
  if (!days) return "📊 За эту неделю записей нет. Начнём со следующей? 💪";
  const wl = w0 != null && w1 != null && w0 !== w1 ? `\nВес: ${fmt1(w0)} → ${fmt1(w1)} кг (${w1 < w0 ? "−" : "+"}${fmt1(Math.abs(w1 - w0))})` : w1 != null ? `\nВес: ${fmt1(w1)} кг` : "";
  return `📊 <b>Неделя</b>\nДней с записями: ${days} из 7\nСреднее: <b>${fmt(sum / days)}</b> ккал в день\nВ пределах нормы: ${inNorm} из ${days} дн.${burn ? `\nСожжено на тренировках: ${fmt(burn)} ккал` : ""}${wl}\n${inNorm >= Math.max(1, days - 1) ? "Отличная неделя! 🎉" : "Новая неделя — новый шанс 💪"}`;
}
