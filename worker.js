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
  const hook = await tg(env, "setWebhook", { url: `${url.origin}/tg`, secret_token: secret, allowed_updates: ["message", "callback_query"] });
  await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  await botUsername(env);
  const okModel = env.ANTHROPIC_API_KEY ? "есть" : "НЕТ — фото еды работать не будет";
  return text(`Готово.\nВебхук: ${hook.ok ? "подключён ✅" : "ошибка: " + JSON.stringify(hook)}\nКлюч ИИ: ${okModel}\nХранилище: ${env.KV ? "подключено ✅" : "НЕТ"}\nAPP_URL: ${env.APP_URL || "НЕ ЗАДАН"}`);
}

async function onTelegram(req, env, ctx) {
  const secret = (await sha("hook" + env.BOT_TOKEN)).slice(0, 40);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return text("no", 403);
  const upd = await req.json();
  if (!(await env.KV.get("hook:v2"))) {   // один раз: включаем кнопки под сообщениями
    await tg(env, "setWebhook", { url: `${new URL(req.url).origin}/tg`, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    await env.KV.put("hook:v2", "1");
  }
  if (upd.callback_query) { ctx.waitUntil(onCallback(env, upd.callback_query).catch(() => {})); return text("ok"); }
  const m = upd.message; if (!m || !m.from) return text("ok");
  if (m.chat && m.chat.type !== "private") return text("ok");
  if (!m.text || !m.text.trim().startsWith("/")) {
    if (m.text || m.voice || m.audio || m.photo) ctx.waitUntil(botMessage(env, m));
    return text("ok");
  }
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
  } else if (cmd === "/stats") {
    const users = await kget(env, "users", []), owner = (await env.KV.get("owner")) || users[0];
    if (uid !== String(owner)) { await send(env, uid, "Эта команда только для владельца бота."); return text("ok"); }
    await send(env, uid, await statsText(env, users));
  } else if (cmd === "/help") {
    await send(env, uid, HELP_TEXT, { reply_markup: openBtn(env, "Открыть дневник 🌿") });
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
    await send(env, uid, "Я понимаю команды /today, /week и /stop. А ещё просто напиши, что ты съела, или пришли голосовое, фото тарелки или ссылку на рецепт 🙂", { reply_markup: openBtn(env) });
  }
  return text("ok");
}

/* ---------------- еда и рецепты прямо в чате с ботом ---------------- */
const MEALS = ["Завтрак", "Обед", "Перекус", "Ужин"];
const autoMeal = h => h < 11 ? "Завтрак" : h < 15 ? "Обед" : h < 18 ? "Перекус" : "Ужин";
const r1 = n => Math.round((+n || 0) * 10) / 10;
const uid8 = () => rid(8) + Date.now().toString(36).slice(-4);

function pickJSON(t) {
  t = String(t || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"); if (a < 0) return null;
  let depth = 0, inStr = false, esc2 = false;
  for (let i = a; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc2) esc2 = false; else if (ch === "\\") esc2 = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(a, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}
async function claudeJSON(env, uid, content, maxTokens = 4000) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("на сервере нет ключа ИИ");
  const day = new Date().toISOString().slice(0, 10), ck = `ai:${uid}:${day}`;
  const used = +(await env.KV.get(ck) || 0);
  if (used >= AI_DAILY_LIMIT) throw new Error(`на сегодня лимит ${AI_DAILY_LIMIT} запросов к ИИ исчерпан`);
  const call = async (model, extra) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: extra ? content.concat([{ type: "text", text: extra }]) : content }] }),
    });
    const raw = await r.text(); let data = {}; try { data = JSON.parse(raw); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  };
  let r = await call(env.AI_MODEL || MODEL_MAIN);
  if (!r.ok && (r.status === 400 || r.status === 404)) r = await call(MODEL_FALLBACK);
  if (!r.ok) throw new Error((r.data.error && r.data.error.message) || ("ИИ ответил ошибкой " + r.status));
  await env.KV.put(ck, String(used + 1), { expirationTtl: 60 * 60 * 30 });
  const textOf = d => (d.content || []).map(c => c.text || "").join("");
  let j = pickJSON(textOf(r.data));
  if (!j) {   // ответ оборвался или пришёл не в том виде — одна повторная попытка, коротко
    const r2 = await call(MODEL_FALLBACK, "Ответь ТОЛЬКО компактным JSON по схеме выше, без пояснений и без markdown.");
    if (r2.ok) j = pickJSON(textOf(r2.data));
  }
  if (!j) throw new Error("ИИ ответил непонятно — попробуй переформулировать или прислать ещё раз");
  return j;
}

/* блюда пользователя — чтобы ИИ узнавал «моя овсянка» */
async function userDishes(env, uid) {
  const d = await kget(env, `u:${uid}:d:dishes`);
  return (d && d.v && d.v.items) || [];
}
function dishStats(d) {
  const tot = { g: 0, kcal: 0, p: 0, f: 0, c: 0 };
  (d.ing || []).forEach(i => { const k = (+i.g || 0) / 100; tot.g += +i.g || 0; tot.kcal += k * (+i.kcal || 0); tot.p += k * (+i.p || 0); tot.f += k * (+i.f || 0); tot.c += k * (+i.c || 0); });
  const g = tot.g || 1, P = Math.max(1, +d.portions || 1);
  return { per100: { kcal: r1(tot.kcal / g * 100), p: r1(tot.p / g * 100), f: r1(tot.f / g * 100), c: r1(tot.c / g * 100) }, portionG: Math.round(tot.g / P), tot, P };
}

/* запись в дневник на сервере (приложение подтянет при открытии) */
async function addMeals(env, uid, date, meal, items) {
  const k = `u:${uid}:d:d-${date}`, cur = await kget(env, k);
  const v = (cur && cur.v) || { date, meals: [], workouts: [] };
  v.meals = v.meals || []; v.workouts = v.workouts || [];
  const ids = [];
  for (const it of items) { const id = uid8(); ids.push(id); v.meals.push({ id, meal, name: it.name, g: r1(it.g), kcal: r1(it.kcal), p: r1(it.p), f: r1(it.f), c: r1(it.c) }); }
  await kput(env, k, { v, at: Date.now() });
  return { ids, day: v };
}
async function removeMeals(env, uid, date, ids) {
  const k = `u:${uid}:d:d-${date}`, cur = await kget(env, k);
  if (!cur || !cur.v) return 0;
  const before = (cur.v.meals || []).length;
  cur.v.meals = (cur.v.meals || []).filter(x => !ids.includes(x.id));
  await kput(env, k, { v: cur.v, at: Date.now() });
  return before - cur.v.meals.length;
}
const totalsOf = list => list.reduce((t, x) => { const k = (+x.g || 0) / 100; t.kcal += k * x.kcal; t.p += k * x.p; t.f += k * x.f; t.c += k * x.c; return t; }, { kcal: 0, p: 0, f: 0, c: 0 });
async function syncSummary(env, uid, date, day) {
  const sk = `d:${uid}:${date}`, s = (await kget(env, sk)) || {};
  const t = totalsOf(day.meals || []);
  const next = { ...s, kcal: Math.round(t.kcal), p: Math.round(t.p), f: Math.round(t.f), c: Math.round(t.c), n: (day.meals || []).length };
  await kput(env, sk, next, 60 * 60 * 24 * 45);
  return next;
}
function loggedText(meal, date, today, items, sum) {
  const t = totalsOf(items);
  const when = date === today ? "" : date === addDays(today, -1) ? " (вчера)" : ` (${date.split("-").reverse().slice(0, 2).join(".")})`;
  const lines = items.map(x => `• ${esc(x.name)} — ${fmt(x.g)} г, ${fmt(x.g / 100 * x.kcal)} ккал`).join("\n");
  let day = "";
  if (date === today && sum) {
    const norm = (sum.norm || 0) + (sum.burn || 0);
    day = norm ? `\n\nЗа сегодня: <b>${fmt(sum.kcal)}</b> из ${fmt(norm)} ккал — ${sum.kcal <= norm ? `осталось ${fmt(norm - sum.kcal)}` : `перебор ${fmt(sum.kcal - norm)}`}` : `\n\nЗа сегодня: <b>${fmt(sum.kcal)}</b> ккал`;
  }
  return `✅ Записала в <b>${meal}</b>${when}:\n${lines}\nИтого: ${fmt(t.kcal)} ккал · Б ${fmt(t.p)} · Ж ${fmt(t.f)} · У ${fmt(t.c)} г${day}`;
}
async function logAndReply(env, uid, s, mealIn, dayOffset, items) {
  const now = localNow(new Date(), s.tz), today = now.toISOString().slice(0, 10);
  const date = addDays(today, Math.max(-7, Math.min(0, Math.round(+dayOffset || 0))));
  const meal = MEALS.includes(mealIn) ? mealIn : autoMeal(now.getUTCHours());
  const { ids, day } = await addMeals(env, uid, date, meal, items);
  const sum = await syncSummary(env, uid, date, day);
  const tok = rid(10); await kput(env, `undo:${uid}:${tok}`, { date, ids }, 60 * 60 * 24 * 2);
  await send(env, uid, loggedText(meal, date, today, items, sum), { reply_markup: { inline_keyboard: [[{ text: "↩️ Отменить", callback_data: `u:${tok}` }, { text: "Открыть дневник", web_app: { url: env.APP_URL } }]] } });
}

const FOOD_TEXT_PROMPT = (dishes) => `Ты — нутрициолог в дневнике питания. Пользователь написал в чат, что съел. Разбери сообщение на отдельные продукты и блюда.
— Вес: если указан — используй его. Если указаны штуки, ложки, стаканы, «тарелка», «порция» — переведи в граммы по типичным размерам (1 яйцо ≈ 55 г, 1 котлета ≈ 80 г, тарелка супа ≈ 300 г, порция гарнира ≈ 150 г, ч. л. сахара ≈ 5 г). Если вес не указан — оцени обычную порцию.
— Пищевая ценность — на 100 г продукта в том виде, как его ели (каша варёная, мясо жареное и т.п.).
— Названия по-русски, коротко: «Гречка варёная», «Котлета куриная жареная».
— meal: если в сообщении сказано «на завтрак/обед/ужин/перекус» — укажи "Завтрак", "Обед", "Перекус" или "Ужин", иначе null.
— day_offset: 0 — сегодня; -1 если «вчера»; -2 если «позавчера».
— Если сообщение — это рецепт или список продуктов для готовки (а не то, что человек съел), верни "type":"recipe" и пустой items.
— Если сообщение не про еду — верни пустой items и в note коротко скажи, что ты понимаешь.
${dishes.length ? `Свои блюда пользователя (если он упоминает их — используй эти значения и порцию):\n${dishes.map(d => { const s = dishStats(d); return `«${d.name}»: порция ${s.portionG} г, на 100 г ${s.per100.kcal} ккал, Б ${s.per100.p}, Ж ${s.per100.f}, У ${s.per100.c}`; }).join("\n")}\n` : ""}Ответь ТОЛЬКО JSON без пояснений:
{"type":"food","meal":null,"day_offset":0,"items":[{"name":"...","grams":число,"kcal":число,"p":число,"f":число,"c":число}],"note":""}`;

async function botFoodText(env, uid, s, textIn, viaVoice) {
  const dishes = (await userDishes(env, uid)).slice(0, 40);
  const j = await claudeJSON(env, uid, [{ type: "text", text: FOOD_TEXT_PROMPT(dishes) + `\n\nСообщение пользователя: «${String(textIn).slice(0, 1500)}»` }]);
  if (j.type === "recipe") return botRecipe(env, uid, String(textIn), null);
  const items = (j.items || []).filter(x => x && x.name).map(x => ({ name: String(x.name).slice(0, 80), g: Math.max(1, Math.round(+x.grams || 100)), kcal: +x.kcal || 0, p: +x.p || 0, f: +x.f || 0, c: +x.c || 0 }));
  if (!items.length) {
    await send(env, uid, `${viaVoice ? `🎙 Услышала: «${esc(textIn)}»\n\n` : ""}${esc(j.note || "Не поняла, что записать.")}\n\nНапиши, что ты съела, например: «на обед 150 г гречки и котлета» — и я запишу в дневник. Можно голосовым или фото тарелки. А ссылку на рецепт я сохраню как блюдо.`, { reply_markup: openBtn(env) });
    return;
  }
  if (viaVoice) await send(env, uid, `🎙 Услышала: «${esc(textIn)}»`);
  await logAndReply(env, uid, s, j.meal, j.day_offset, items);
}

async function tgFileBytes(env, fileId) {
  const f = await tg(env, "getFile", { file_id: fileId });
  if (!f.ok) throw new Error("не получилось скачать файл из Telegram");
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) throw new Error("не получилось скачать файл из Telegram");
  return { bytes: new Uint8Array(await r.arrayBuffer()), path: f.result.file_path };
}
const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

async function botVoice(env, uid, s, m) {
  if (!env.AI) { await send(env, uid, "Голосовые пока не подключены на сервере. Напиши текстом, что ты съела 🙂"); return; }
  const v = m.voice || m.audio;
  if ((v.duration || 0) > 120) { await send(env, uid, "Голосовое длинновато — уложись в 2 минуты 🙂"); return; }
  const { bytes } = await tgFileBytes(env, v.file_id);
  let textOut = "";
  try { const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: b64(bytes), language: "ru" }); textOut = (r && r.text) || ""; }
  catch (e) { const r = await env.AI.run("@cf/openai/whisper", { audio: [...bytes] }); textOut = (r && r.text) || ""; }
  textOut = textOut.trim();
  if (!textOut) { await send(env, uid, "Не разобрала голосовое 😔 Попробуй ещё раз или напиши текстом."); return; }
  if (/https?:\/\//.test(textOut)) return botRecipeUrl(env, uid, textOut.match(/https?:\/\/\S+/)[0]);
  await botFoodText(env, uid, s, textOut, true);
}

async function botPhoto(env, uid, s, m) {
  const ph = m.photo[m.photo.length - 1];
  const { bytes } = await tgFileBytes(env, ph.file_id);
  const res = await aiPhoto(env, { id: uid }, { image: b64(bytes), mime: "image/jpeg", hint: m.caption || "" });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  const items = (j.items || []).map(x => ({ name: x.name, g: x.grams, kcal: x.kcal, p: x.p, f: x.f, c: x.c }));
  if (!items.length) { await send(env, uid, `На фото не нашла еду. ${esc(j.note || "")}\nПопробуй сфотографировать тарелку поближе или напиши текстом.`); return; }
  const cap = (m.caption || "").toLowerCase();
  const meal = /завтрак/.test(cap) ? "Завтрак" : /обед/.test(cap) ? "Обед" : /ужин/.test(cap) ? "Ужин" : /перекус/.test(cap) ? "Перекус" : null;
  await logAndReply(env, uid, s, meal, /вчера/.test(cap) ? -1 : 0, items);
}

/* ---------- рецепт по ссылке или тексту → блюдо ---------- */
function recipeFromLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(x => x[1]);
  const walk = o => {
    if (!o || typeof o !== "object") return null;
    if (Array.isArray(o)) { for (const x of o) { const r = walk(x); if (r) return r; } return null; }
    const t = o["@type"]; if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return o;
    if (o["@graph"]) return walk(o["@graph"]);
    return null;
  };
  for (const b of blocks) { try { const r = walk(JSON.parse(b.trim())); if (r) return r; } catch (e) {} }
  return null;
}
const htmlText = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const RECIPE_PROMPT = `Ты — нутрициолог. По рецепту составь блюдо для дневника питания.
— name: короткое название блюда по-русски.
— portions: число порций из рецепта (если не указано — оцени).
— ing: ингредиенты на ВСЁ блюдо. Вес каждого — в граммах (переведи штуки, ложки, стаканы, «щепотку»; специи и соль можно не включать, если их меньше 5 г). Пищевая ценность — на 100 г ингредиента в том виде, как он кладётся в блюдо (обычно сырой). Названия по-русски, коротко.
— Воду, бульон и молоко для варки включай как ингредиенты (вода — 0 ккал): от них зависит вес порции. Для супов и каш учти, что примерно 15–20% воды выкипает — уменьши вес воды на эту долю.
— Если текст — не рецепт, верни пустой ing и в note скажи, что не так.
Ответь ТОЛЬКО JSON без пояснений:
{"name":"...","portions":число,"ing":[{"name":"...","g":число,"kcal":число,"p":число,"f":число,"c":число}],"note":""}`;

async function saveDish(env, uid, dish) {
  const k = `u:${uid}:d:dishes`, cur = await kget(env, k);
  const items = (cur && cur.v && cur.v.items) || [];
  let name = dish.name, n = 2;
  while (items.some(x => String(x.name).toLowerCase() === name.toLowerCase())) name = `${dish.name} (${n++})`;
  const d = { ...dish, name };
  await kput(env, k, { v: { items: items.concat([d]) }, at: Date.now() });
  return d;
}
async function botRecipe(env, uid, sourceText, sourceUrl) {
  const j = await claudeJSON(env, uid, [{ type: "text", text: RECIPE_PROMPT + `\n\nРецепт${sourceUrl ? ` (${sourceUrl})` : ""}:\n${sourceText.slice(0, 14000)}` }], 2500);
  const ing = (j.ing || []).filter(x => x && x.name && +x.g > 0).map(x => ({ name: String(x.name).slice(0, 60), g: Math.round(+x.g), kcal: r1(x.kcal), p: r1(x.p), f: r1(x.f), c: r1(x.c) }));
  if (!ing.length) { await send(env, uid, `Не получилось разобрать рецепт. ${esc(j.note || "")}\nПопробуй прислать текст рецепта сообщением — с ингредиентами и количеством.`); return; }
  const dish = await saveDish(env, uid, { id: uid8(), name: String(j.name || "Блюдо по рецепту").slice(0, 60), portions: Math.max(1, Math.round(+j.portions || 1)), ing, src: sourceUrl || undefined });
  const st = dishStats(dish), per = st.tot.kcal / st.P;
  await send(env, uid, `🍲 Сохранила блюдо <b>«${esc(dish.name)}»</b>\n${st.P} ${st.P === 1 ? "порция" : st.P < 5 ? "порции" : "порций"} по ~${fmt(st.portionG)} г — <b>${fmt(per)} ккал</b> на порцию\nБ ${fmt(st.tot.p / st.P)} · Ж ${fmt(st.tot.f / st.P)} · У ${fmt(st.tot.c / st.P)} г на порцию\n\nИнгредиенты: ${ing.map(i => `${esc(i.name)} ${fmt(i.g)} г`).join(", ")}\n\nБлюдо уже в «Меню» → «Блюда» — его можно добавить в план недели или в дневник. Если что-то посчиталось не так, поправь там.`,
    { reply_markup: { inline_keyboard: [[{ text: "🍽 Записать 1 порцию", callback_data: `rp:${dish.id}` }], [{ text: "Открыть дневник", web_app: { url: env.APP_URL } }]] } });
}
async function botRecipeUrl(env, uid, link) {
  let html = "";
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(link, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "accept-language": "ru,en;q=0.8" } });
    clearTimeout(tm);
    if (r.ok) html = (await r.text()).slice(0, 2_000_000);
  } catch (e) {}
  let ld = html ? recipeFromLd(html) : null;
  if (!ld && (!html || htmlText(html).length < 400)) {   // сайт не пустил или отдал пустую страницу — читаем через «читалку»
    try {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch("https://r.jina.ai/" + link, { signal: ctl.signal, headers: { "accept": "text/plain", "x-return-format": "text" } });
      clearTimeout(tm);
      if (r.ok) { const tx = (await r.text()).slice(0, 60000); if (tx.length > 300) html = `<body>${tx.replace(/</g, " ")}</body>`; }
    } catch (e) {}
  }
  if (!html) { await send(env, uid, "Не получилось открыть эту страницу — сайт не пускает. Скопируй текст рецепта (ингредиенты с количеством) и пришли сообщением — я сохраню блюдо."); return; }
  let src;
  if (ld) {
    const ingr = [].concat(ld.recipeIngredient || ld.ingredients || []).join("\n");
    src = `Название: ${ld.name || ""}\nПорций: ${[].concat(ld.recipeYield || "").join(" ")}\nИнгредиенты:\n${ingr}`;
  } else src = htmlText(html);
  if (ld ? ![].concat(ld.recipeIngredient || ld.ingredients || []).length : src.length < 200) { await send(env, uid, "На странице не нашла рецепт. Пришли текст рецепта сообщением — я сохраню блюдо."); return; }
  await botRecipe(env, uid, src, link);
}

/* ---------- кнопки под сообщениями ---------- */
async function onCallback(env, cq) {
  const uid = String(cq.from.id), data = String(cq.data || "");
  const ack = t => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: t || "" });
  if (data.startsWith("u:")) {
    const u = await kget(env, `undo:${uid}:${data.slice(2)}`);
    if (!u) { await ack("Уже нельзя отменить"); return; }
    const n = await removeMeals(env, uid, u.date, u.ids);
    await env.KV.delete(`undo:${uid}:${data.slice(2)}`);
    const cur = await kget(env, `u:${uid}:d:d-${u.date}`); if (cur && cur.v) await syncSummary(env, uid, u.date, cur.v);
    await ack(n ? "Отменила" : "Записей уже нет");
    if (cq.message) await tg(env, "editMessageText", { chat_id: uid, message_id: cq.message.message_id, text: "↩️ Запись отменена.", parse_mode: "HTML" });
    return;
  }
  if (data.startsWith("rp:")) {
    const d = (await userDishes(env, uid)).find(x => x.id === data.slice(3));
    if (!d) { await ack("Блюдо не найдено"); return; }
    await ack("Записываю…");
    const st = dishStats(d), s = await userSettings(env, uid);
    await logAndReply(env, uid, s, null, 0, [{ name: d.name, g: st.portionG, ...st.per100 }]);
    return;
  }
  await ack();
}

function looksLikeRecipe(t) {
  if (/ингредиент|рецепт|приготовлени|способ приготов|на \d+ порци|\(на \d+|порци[йи]\)/i.test(t) && t.length > 80) return true;
  const lines = t.split(/\n/).filter(x => x.trim());
  const qty = lines.filter(x => /\d+\s*(г|гр|кг|мл|л|шт|ст\.?|ч\.?\s*л|ложк|зубч|стакан)|по вкусу/i.test(x)).length;
  return lines.length >= 5 && qty >= 4 && /по вкусу|вода|порци/i.test(t);
}
async function botMessage(env, m) {
  const uid = String(m.from.id), s = await userSettings(env, uid);
  await ensureUser(env, uid, m.from.first_name || "");
  await tg(env, "sendChatAction", { chat_id: uid, action: "typing" });
  try {
    if (m.voice || m.audio) return await botVoice(env, uid, s, m);
    if (m.photo) return await botPhoto(env, uid, s, m);
    const t = (m.text || "").trim();
    const link = t.match(/https?:\/\/[^\s]+/);
    if (link) return await botRecipeUrl(env, uid, link[0]);
    if (looksLikeRecipe(t)) return await botRecipe(env, uid, t, null);
    return await botFoodText(env, uid, s, t, false);
  } catch (e) {
    await send(env, uid, `Не получилось: ${esc(String(e && e.message || e))}. Попробуй ещё раз чуть позже или запиши в приложении.`, { reply_markup: openBtn(env) });
  }
}

/* ---------------- вступление бота ---------------- */
const BOT_DESC = "Дневник похудения 🌿\n\n🍽 Считает калории и БЖУ: пишешь продукт и граммы — остальное посчитается само\n✍️ Можно писать прямо в чат: «на обед 150 г гречки и котлета» — или голосовым\n🔗 Пришли ссылку на рецепт — сохраню блюдо с калориями\n📷 Еда по фото, штрихкоду и этикетке\n📅 Меню на неделю и список покупок\n⚖️ Вес, прогресс и прогноз до цели\n❤️ Шаги и активность из «Здоровья» на iPhone\n👨‍👩‍👧 Общее меню для семьи\n🔔 Напоминания и итоги дня и недели\n\nНажми «Старт» — и начнём.";
const BOT_SHORT = "Считаю калории по продукту и граммам, фото и штрихкоду. Меню на неделю, вес, шаги и напоминания 🌿";
async function botDescribe(env) {
  if (await env.KV.get("desc:v3")) return;
  await tg(env, "setMyDescription", { description: BOT_DESC });
  await tg(env, "setMyShortDescription", { short_description: BOT_SHORT });
  await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  await env.KV.put("desc:v3", "1");
}
const BOT_COMMANDS = [
  { command: "start", description: "Начать" },
  { command: "help", description: "Что я умею и как записывать еду" },
  { command: "today", description: "Итог сегодняшнего дня" },
  { command: "week", description: "Отчёт за неделю" },
  { command: "stop", description: "Выключить напоминания" },
];
const HELP_TEXT = `<b>Как записывать еду прямо здесь, в чате</b> ✍️

<b>Текстом</b> — просто напиши, что съела:
• <i>на обед 150 г гречки и куриная котлета</i>
• <i>завтрак: 2 яйца, кофе с молоком</i>
• <i>вчера на ужин тарелка борща</i>
Вес можно не писать — я оценю обычную порцию. Понимаю штуки, ложки, «тарелку», «порцию» и твои блюда из «Меню».

🎙 <b>Голосовым</b> — скажи то же самое голосом.

📷 <b>Фото тарелки</b> — я сама определю блюда и вес. В подписи можно добавить «завтрак» или «вчера».

После записи я покажу калории и сколько осталось на сегодня. Ошиблась — нажми «↩️ Отменить».

🔗 <b>Рецепт по ссылке</b> — пришли ссылку на рецепт с любого сайта, и я сохраню блюдо в «Меню» → «Блюда» с калориями на порцию. Если сайт не открывается — пришли текст рецепта сообщением.

<b>Команды</b>
/today — итог дня
/week — отчёт за неделю
/stop — выключить напоминания
/help — эта подсказка

Всё остальное — меню, вес, прогресс, семья — в дневнике 👇`;
const NEWS_TEXT = `🆕 <b>Теперь еду можно записывать прямо в этом чате!</b>

✍️ Напиши, что съела: <i>«на обед 150 г гречки и котлета»</i>
🎙 Или скажи голосовым
📷 Или пришли фото тарелки
🔗 А ссылку на рецепт я сохраню как блюдо с калориями

Подробнее — /help`;
async function sendNewsOnce(env) {
  if (await env.KV.get("news:v1")) return;
  await env.KV.put("news:v1", "1");
  const users = await kget(env, "users", []);
  for (const uid of users) { try { await send(env, uid, NEWS_TEXT, { reply_markup: openBtn(env) }); } catch (e) {} }
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

✍️ <b>Пиши мне прямо сюда</b>: «на обед 150 г гречки и котлета» — запишу в дневник. Голосовые и фото тарелки тоже понимаю.
🔗 <b>Пришли ссылку на рецепт</b> — сохраню блюдо с калориями на порцию.

<b>С чего начать — 3 шага:</b>
1️⃣ Нажми «Открыть дневник» ниже
2️⃣ Заполни <b>профиль</b>: пол, возраст, рост, вес и цель — и нажми «Сохранить профиль». Без него я не посчитаю твою норму калорий
3️⃣ Записывай еду — остальное посчитается само. В каждом разделе будут подсказки

Как записывать еду в чате — /help
Команды: /today — итог дня, /week — отчёт за неделю, /stop — выключить напоминания.`;
}

/* ---------------- кабинет тренера ---------------- */
const FREE_CLIENTS = 3;
const userName = async (env, uid) => (await env.KV.get(`n:${uid}`)) || "Без имени";
async function coachInfo(env, uid) {   // для клиента: кто имеет доступ и комментарии
  const ids = await kget(env, `cl:${uid}`, []);
  const trainers = [];
  for (const t of ids) { const tp = await kget(env, `tp:${t}`); trainers.push({ uid: t, name: (tp && tp.name) || await userName(env, t) }); }
  const comments = (await kget(env, `cm:${uid}`, [])).slice(0, 120);
  return { trainers, comments };
}
async function trainerApi(env, user, p, body, req, url) {
  const me = user.id;
  const linkFor = async code => { const bot = await botUsername(env); return `https://t.me/${bot}?startapp=t_${code}`; };
  if (p === "trainer" && req.method === "GET") {
    const tp = await kget(env, `tp:${me}`);
    if (!tp || !tp.on) return json({ on: false });
    const ids = await kget(env, `tl:${me}`, []), clients = [];
    for (const c of ids) clients.push({ uid: c, name: await userName(env, c) });
    return json({ on: true, name: tp.name, code: tp.code, link: await linkFor(tp.code), clients, limit: FREE_CLIENTS });
  }
  if (p === "trainer/enable") {
    let tp = await kget(env, `tp:${me}`);
    if (!tp) { let code; do { code = rid(8); } while (await env.KV.get(`tc:${code}`)); tp = { code }; await env.KV.put(`tc:${code}`, me); }
    tp.on = true; tp.name = String(body.name || tp.name || user.name).slice(0, 40);
    await kput(env, `tp:${me}`, tp);
    return json({ ok: true, link: await linkFor(tp.code) });
  }
  if (p === "trainer/disable") {
    const tp = await kget(env, `tp:${me}`); if (tp) { tp.on = false; await kput(env, `tp:${me}`, tp); }
    return json({ ok: true });
  }
  if (p === "trainer/client") {   // дневник клиента — только просмотр
    const c = String(url.searchParams.get("uid") || body.uid || "");
    if (!(await kget(env, `tl:${me}`, [])).includes(c)) return json({ error: "Нет доступа к этому клиенту" }, 403);
    const pre = `u:${c}:d:`, docs = {}, since = addDays(new Date().toISOString().slice(0, 10), -90);
    for (const [k, v] of await env.KV.listPrefix(pre)) {
      const key = k.slice(pre.length);
      if (key === "profile" || key === "weights" || (/^d-\d{4}-\d{2}-\d{2}$/.test(key) && key.slice(2) >= since)) { try { const d = JSON.parse(v); if (d && d.v != null) docs[key] = d.v; } catch (e) {} }
    }
    const comments = (await kget(env, `cm:${c}`, [])).filter(x => x.from === me);
    return json({ uid: c, name: await userName(env, c), docs, comments });
  }
  if (p === "trainer/comment") {
    const c = String(body.client || ""), txt = String(body.text || "").trim().slice(0, 1000);
    if (!(await kget(env, `tl:${me}`, [])).includes(c)) return json({ error: "Нет доступа к этому клиенту" }, 403);
    if (!txt || !/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) return json({ error: "Пустой комментарий" }, 400);
    const tp = await kget(env, `tp:${me}`), tname = (tp && tp.name) || user.name;
    const it = { id: rid(10), from: me, name: tname, date: body.date, meal: body.meal ? String(body.meal).slice(0, 80) : null, text: txt, at: Date.now() };
    const list = [it, ...(await kget(env, `cm:${c}`, []))].slice(0, 200);
    await kput(env, `cm:${c}`, list);
    const d = body.date.split("-").reverse().slice(0, 2).join(".");
    await send(env, c, `💬 <b>Тренер ${esc(tname)}</b> — комментарий к ${d}${it.meal ? ` (${esc(it.meal)})` : ""}:\n\n${esc(txt)}`, { reply_markup: openBtn(env) });
    return json({ ok: true, comment: it });
  }
  if (p === "trainer/comment/delete") {
    const c = String(body.client || "");
    const list = (await kget(env, `cm:${c}`, [])).filter(x => !(x.id === body.id && x.from === me));
    await kput(env, `cm:${c}`, list); return json({ ok: true });
  }
  if (p === "trainer/remove") {
    const c = String(body.client || "");
    await kput(env, `tl:${me}`, (await kget(env, `tl:${me}`, [])).filter(x => x !== c));
    await kput(env, `cl:${c}`, (await kget(env, `cl:${c}`, [])).filter(x => x !== me));
    return json({ ok: true });
  }
  /* --- сторона клиента --- */
  if (p === "coach" && req.method === "GET") return json(await coachInfo(env, me));
  if (p === "coach/preview") {
    const t = await env.KV.get(`tc:${String(body.code || "").replace(/[^a-z0-9]/g, "")}`);
    const tp = t ? await kget(env, `tp:${t}`) : null;
    if (!tp || !tp.on) return json({ error: "Приглашение не найдено или тренер выключил кабинет" }, 404);
    return json({ name: tp.name, self: t === me, already: (await kget(env, `cl:${me}`, [])).includes(t) });
  }
  if (p === "coach/join") {
    const t = await env.KV.get(`tc:${String(body.code || "").replace(/[^a-z0-9]/g, "")}`);
    const tp = t ? await kget(env, `tp:${t}`) : null;
    if (!tp || !tp.on) return json({ error: "Приглашение не найдено или тренер выключил кабинет" }, 404);
    if (t === me) return json({ error: "Это твоя собственная ссылка тренера" }, 400);
    const tl = await kget(env, `tl:${t}`, []);
    if (!tl.includes(me)) {
      if (tl.length >= FREE_CLIENTS) return json({ error: `У тренера уже ${FREE_CLIENTS} клиента — это максимум на бесплатном тарифе. Напиши ему об этом.` }, 400);
      tl.push(me); await kput(env, `tl:${t}`, tl);
      const cl = await kget(env, `cl:${me}`, []); if (!cl.includes(t)) { cl.push(t); await kput(env, `cl:${me}`, cl); }
      await send(env, t, `👋 Новый клиент: <b>${esc(user.name)}</b> дал(а) доступ к дневнику. Открой «Профиль» → «Кабинет тренера».`, { reply_markup: openBtn(env) });
    }
    return json({ ok: true, ...(await coachInfo(env, me)) });
  }
  if (p === "coach/leave") {
    const t = String(body.trainer || "");
    await kput(env, `cl:${me}`, (await kget(env, `cl:${me}`, [])).filter(x => x !== t));
    await kput(env, `tl:${t}`, (await kget(env, `tl:${t}`, [])).filter(x => x !== me));
    await send(env, t, `${esc(user.name)} закрыл(а) тебе доступ к своему дневнику.`);
    return json({ ok: true, ...(await coachInfo(env, me)) });
  }
  return json({ error: "unknown" }, 404);
}
/* утренняя сводка тренеру */
async function trainerMorning(env, uid, yesterday) {
  const tp = await kget(env, `tp:${uid}`); if (!tp || !tp.on) return;
  const ids = await kget(env, `tl:${uid}`, []); if (!ids.length) return;
  const lines = [];
  for (const c of ids) {
    const name = await userName(env, c), d = await kget(env, `d:${c}:${yesterday}`);
    if (!d || !d.n) { lines.push(`❗ <b>${esc(name)}</b> — не записывал(а) еду`); continue; }
    const norm = (d.norm || 0) + (d.burn || 0);
    if (!norm) { lines.push(`• <b>${esc(name)}</b> — ${fmt(d.kcal)} ккал`); continue; }
    const diff = d.kcal - norm;
    lines.push(diff > 100 ? `⚠️ <b>${esc(name)}</b> — ${fmt(d.kcal)} из ${fmt(norm)} ккал, перебор ${fmt(diff)}` : `✅ <b>${esc(name)}</b> — ${fmt(d.kcal)} из ${fmt(norm)} ккал`);
  }
  await send(env, uid, `☀️ <b>Клиенты за вчера</b>\n\n${lines.join("\n")}`, { reply_markup: openBtn(env, "Открыть кабинет") });
}

/* ---------------- статистика для владельца ---------------- */
async function statsText(env, users) {
  const now = Date.now(), DAY = 864e5;
  let prof = 0, a1 = 0, a7 = 0, a30 = 0, n7 = 0, n30 = 0, logged7 = 0, fam = new Set(), aiToday = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const uid of users) {
    const rows = await env.KV.listPrefix(`u:${uid}:d:`);
    let last = 0, hasProf = false, days7 = new Set();
    for (const [k, v] of rows) {
      let d = null; try { d = JSON.parse(v); } catch (e) {}
      if (!d) continue;
      const key = k.slice(`u:${uid}:d:`.length);
      if (key === "profile" && d.v) hasProf = true;
      if (d.at > last) last = d.at;
      if (/^d-\d{4}-\d{2}-\d{2}$/.test(key) && d.v && (d.v.meals || []).length && now - Date.parse(key.slice(2)) < 7 * DAY) days7.add(key);
    }
    if (hasProf) prof++;
    if (now - last < DAY) a1++; if (now - last < 7 * DAY) a7++; if (now - last < 30 * DAY) a30++;
    if (days7.size >= 3) logged7++;
    const j = +(await env.KV.get(`j:${uid}`) || 0);
    if (j && now - j < 7 * DAY) n7++; if (j && now - j < 30 * DAY) n30++;
    const f = await env.KV.get(`uf:${uid}`); if (f) fam.add(f);
    aiToday += +(await env.KV.get(`ai:${uid}:${today}`) || 0);
  }
  return `📊 <b>Статистика бота</b>

👥 Всего пользователей: <b>${users.length}</b>
🆕 Новых за 7 дней: ${n7} · за 30 дней: ${n30}
✍️ Заполнили профиль: ${prof}
🔥 Пользовались: сегодня ${a1} · за 7 дней ${a7} · за 30 дней ${a30}
📅 Записывали еду 3+ дня за неделю: ${logged7}
👨‍👩‍👧 Семей: ${fam.size}
🤖 Запросов к ИИ сегодня: ${aiToday}

<i>«Новые» считаются с ${new Date(+(await env.KV.get("stats:since")) || now).toLocaleDateString("ru-RU")} — раньше дата прихода не записывалась.</i>`;
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
  if (!list.includes(uid)) { list.push(uid); await kput(env, "users", list); await env.KV.put(`j:${uid}`, String(Date.now())); }
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
    return json({ docs, me: { id: user.id, name: user.name }, health: await kget(env, `hp:${user.id}`), coach: await coachInfo(env, user.id) });
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
  if (p.startsWith("trainer") || p.startsWith("coach")) return await trainerApi(env, user, p, body, req, url);
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
  try { await sendNewsOnce(env); } catch (e) {}
  try { if (!(await env.KV.get("stats:since"))) await env.KV.put("stats:since", String(Date.now())); } catch (e) {}
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
      if (hm === "08:00") await trainerMorning(env, uid, addDays(today, -1));
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
