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
  async kdelPrefix(prefix) { const m = await this.ctx.storage.list({ prefix }); const ks = [...m.keys()]; for (let i = 0; i < ks.length; i += 128) await this.ctx.storage.delete(ks.slice(i, i + 128)); return ks.length; }
  // резервная копия внутри хранилища: раз в неделю, храним 4 последние
  async snapshot(tag, keep = 4) {
    const skip = /^(bk:|ai:|sg:|undo:|mn:|rvw:|ln:|sess:|rcp:)/;
    const all = await this.ctx.storage.list(), now = Date.now(); let batch = {}, n = 0, cnt = 0;
    for (const [k, r] of all) { if (skip.test(k) || (r && r.exp && r.exp < now)) continue; batch[`bk:${tag}:${k}`] = r; n++; cnt++; if (n === 128) { await this.ctx.storage.put(batch); batch = {}; n = 0; } }
    if (n) await this.ctx.storage.put(batch);
    const idx = ((await this.ctx.storage.get("bkidx")) || []).filter(t => t !== tag).concat([tag]).sort();
    while (idx.length > keep) await this.kdelPrefix(`bk:${idx.shift()}:`);
    await this.ctx.storage.put("bkidx", idx);
    return { tag, keys: cnt, kept: idx };
  }
  async purgeBackups(uid) {   // при удалении аккаунта — убрать человека и из резервных копий
    const re = new RegExp(`^bk:[^:]+:(?:(?:u|d|ai|mn|rvw|sg|undo):${uid}:|(?:s|hp|j|n|uf|uhk|cl|cm|tl|tp):${uid}$)`);
    const m = await this.ctx.storage.list({ prefix: "bk:" }); const ks = [...m.keys()].filter(k => re.test(k));
    for (let i = 0; i < ks.length; i += 128) await this.ctx.storage.delete(ks.slice(i, i + 128));
    return ks.length;
  }
}
function storeKV(env) {
  if (env.KV) {
    const kv = env.KV;
    return {
      get: (k, t) => kv.get(k, t), put: (k, v, o) => kv.put(k, v, o), delete: k => kv.delete(k),
      async listPrefix(prefix) { const out = []; let cursor; do { const r = await kv.list({ prefix, cursor }); for (const x of r.keys) out.push([x.name, await kv.get(x.name)]); cursor = r.list_complete ? null : r.cursor; } while (cursor); return out; },
      async putMany(entries) { for (const [k, v] of entries) await kv.put(k, String(v)); },
      async delPrefix(prefix) { const l = await this.listPrefix(prefix); for (const [k] of l) await kv.delete(k); return l.length; },
      async snapshot() { return null; },
    };
  }                       // если подключено обычное KV — используем его
  const stub = () => env.STORE.get(env.STORE.idFromName("main"));
  return {
    async get(k, type) { const v = await stub().kget(k); if (v == null) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v, opts) { await stub().kput(k, String(v), opts && opts.expirationTtl); },
    async delete(k) { await stub().kdel(k); },
    async listPrefix(prefix) { return await stub().klist(prefix); },
    async putMany(entries) { await stub().kputMany(entries.map(([k, v]) => [k, String(v)])); },
    async delPrefix(prefix) { return await stub().kdelPrefix(prefix); },
    async snapshot(tag) { return await stub().snapshot(tag); },
    async purgeBackups(uid) { return await stub().purgeBackups(uid); },
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
    const t = new Date(event.scheduledTime);
    if (t.getUTCDay() === 1 && t.getUTCHours() === 3 && t.getUTCMinutes() < 30 && env.KV.snapshot) ctx.waitUntil(env.KV.snapshot(t.toISOString().slice(0, 10)).catch(() => {}));
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

/* ---------------- удаление аккаунта: все данные человека с сервера ---------------- */
async function deleteAccount(env, uid) {
  let n = 0;
  // семья
  const fc = await env.KV.get(`uf:${uid}`);
  if (fc) { const f = await kget(env, `fam:${fc}`); if (f && f.members) { f.members = f.members.filter(m => m.id !== uid); if (!f.members.length) await env.KV.delete(`fam:${fc}`); else { if (f.owner === uid) f.owner = f.members[0].id; await kput(env, `fam:${fc}`, f); } } }
  // как клиент тренера
  for (const t of (await kget(env, `cl:${uid}`, [])) || []) await kput(env, `tl:${t}`, ((await kget(env, `tl:${t}`, [])) || []).filter(x => x !== uid));
  // как тренер
  for (const c of (await kget(env, `tl:${uid}`, [])) || []) await kput(env, `cl:${c}`, ((await kget(env, `cl:${c}`, [])) || []).filter(x => x !== uid));
  for (const [k, v] of await env.KV.listPrefix("tc:")) { let x = v; try { x = JSON.parse(v); } catch (e) {} if (String(x && x.uid || x) === uid) { await env.KV.delete(k); n++; } }
  // ключ «Здоровья»
  const hk = await env.KV.get(`uhk:${uid}`); if (hk) await env.KV.delete(`hk:${hk}`);
  // сессии входа
  for (const [k, v] of await env.KV.listPrefix("sess:")) { let x = v; try { x = JSON.parse(v); } catch (e) {} if (x && String(x.id) === uid) { await env.KV.delete(k); n++; } }
  for (const k of ["s", "hp", "j", "n", "uf", "uhk", "cl", "cm", "tl", "tp"]) { await env.KV.delete(`${k}:${uid}`); n++; }
  for (const pf of ["u", "d", "ai", "mn", "rvw", "sg", "undo"]) n += await env.KV.delPrefix(`${pf}:${uid}:`);
  await kput(env, "users", ((await kget(env, "users", [])) || []).filter(x => String(x) !== uid));
  if (env.KV.purgeBackups) n += await env.KV.purgeBackups(uid);
  return { ok: true, removed: n };
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
  await kput(env, `sess:${token}`, { id: r.uid, name: r.name }, 60 * 60 * 24 * 90);
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
    if (arg === "pilot") {   // заявка тренера с сайта
      await ensureUser(env, uid, m.from.first_name || "");
      const users = await kget(env, "users", []), owner = (await env.KV.get("owner")) || users[0];
      const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || "Без имени";
      if (owner && owner !== uid) await send(env, owner, `🙋 <b>Заявка в пилот для тренеров</b>\n${esc(who)}${m.from.username ? ` — @${esc(m.from.username)}` : ""}\n<a href="tg://user?id=${uid}">Написать</a>`);
      await send(env, uid, "Спасибо! Заявка в пилот принята — мы напишем тебе в Telegram. А пока можно уже попробовать: открой дневник → «Профиль» → «Кабинет тренера» → «Я тренер».", { reply_markup: openBtn(env, "Открыть дневник 🌿") });
      return text("ok");
    }
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
  } else if (cmd === "/review") {
    const s = await userSettings(env, uid);
    ctx.waitUntil((async () => { try { await tg(env, "sendChatAction", { chat_id: uid, action: "typing" }); const rv = await weekReview(env, uid, addDays(localDate(new Date(), s.tz), 1)); await send(env, uid, rv || "Для разбора нужно хотя бы 3 дня с записями за последнюю неделю 🙂", { reply_markup: openBtn(env) }); } catch (e) { await send(env, uid, "Не получилось сделать разбор: " + esc(String(e.message || e))); } })());
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
const RU_ONLY = "\nПиши только по-русски: никаких английских слов и латиницы (кроме единиц вроде «г»).";
const hasLatin = o => /[A-Za-z]{3,}/.test(JSON.stringify(o).replace(/"[a-z]{1,6}":/g, ""));
function repairJSON(t) {   // частые огрехи модели: «умные» кавычки вокруг ключей, запятые перед скобкой, десятичная запятая в массивах
  t = String(t || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b <= a) return null;
  let x = t.slice(a, b + 1).replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(x); } catch (e) {}
  // кавычки внутри строк: закрывающая — только если дальше идёт , : } ]
  let out = "", inS = false;
  for (let i = 0; i < x.length; i++) {
    const ch = x[i];
    if (inS && ch === "\\") { out += ch + (x[i + 1] || ""); i++; continue; }
    if (ch === '"') {
      if (!inS) { inS = true; out += ch; continue; }
      let k = i + 1; while (k < x.length && /\s/.test(x[k])) k++;
      if (k >= x.length || ",:}]".includes(x[k])) { inS = false; out += ch; } else out += '\\"';
      continue;
    }
    out += ch;
  }
  try { return JSON.parse(out); } catch (e) { return null; }
}
async function claudeJSON(env, uid, content, maxTokens = 4000, model, schema) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("на сервере нет ключа ИИ");
  const day = new Date().toISOString().slice(0, 10), ck = `ai:${uid}:${day}`;
  const used = +(await env.KV.get(ck) || 0);
  if (used >= AI_DAILY_LIMIT) throw new Error(`на сегодня лимит ${AI_DAILY_LIMIT} запросов к ИИ исчерпан`);
  // ответ через «инструмент» — тогда API само гарантирует корректный JSON
  const TOOL = schema ? [{ name: "answer", description: "Верни результат строго в этой структуре.", input_schema: schema }] : null;
  const call = async (model, extra, useTool = !!TOOL) => {
    const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: extra ? content.concat([{ type: "text", text: extra }]) : content }] };
    if (useTool) { body.tools = TOOL; body.tool_choice = { type: "tool", name: "answer" }; }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await r.text(); let data = {}; try { data = JSON.parse(raw); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  };
  const extract = d => {
    const tu = (d.content || []).find(c => c.type === "tool_use" && c.input && typeof c.input === "object");
    if (tu && Object.keys(tu.input).length) return tu.input;
    const t = (d.content || []).map(c => c.text || "").join("");
    return pickJSON(t) || repairJSON(t);
  };
  let r = await call(model || env.AI_MODEL || MODEL_MAIN);
  if (!r.ok && r.status === 400) r = await call(model || env.AI_MODEL || MODEL_MAIN, null, false);   // если модель не умеет инструменты
  if (!r.ok && (r.status === 400 || r.status === 404)) r = await call(model ? MODEL_MAIN : MODEL_FALLBACK);
  if (!r.ok) throw new Error((r.data.error && r.data.error.message) || ("ИИ ответил ошибкой " + r.status));
  await env.KV.put(ck, String(used + 1), { expirationTtl: 60 * 60 * 30 });
  let j = extract(r.data);
  const why = d => { const t = (d.content || []).map(c => c.type === "text" ? c.text : c.type === "tool_use" ? JSON.stringify(c.input) : `[${c.type}]`).join(" "); return `${d.stop_reason || "?"}; ${t.replace(/\s+/g, " ").slice(0, 160)}`; };
  let diag = why(r.data);
  if (!j) {   // ответ оборвался или пришёл не в том виде — одна повторная попытка той же моделью
    const r2 = await call(model || env.AI_MODEL || MODEL_MAIN, "Верни результат строго в описанной структуре, компактно.");
    if (r2.ok) { j = extract(r2.data); diag += " | " + why(r2.data); } else diag += " | ошибка " + r2.status;
  }
  if (!j) throw new Error("ИИ ответил непонятно — попробуй ещё раз. Подробности для Claude: " + diag);
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
  for (const it of items) { const id = uid8(); ids.push(id); v.meals.push({ id, meal, name: it.name, g: r1(it.g), kcal: r1(it.kcal), p: r1(it.p), f: r1(it.f), c: r1(it.c), ...(it.fb != null && !isNaN(+it.fb) ? { fb: r1(+it.fb) } : {}) }); }
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

/* справочник продуктов приложения: [название, ккал, Б, Ж, У] на 100 г */
const BASE_FOODS = [["Гречка варёная",110,4.2,1.1,21.3],["Гречка сухая",313,12.6,3.3,62.1],["Рис белый варёный",116,2.2,0.5,24.9],["Рис белый сухой",344,6.7,0.7,78.9],["Рис бурый варёный",111,2.6,0.9,23],["Овсяные хлопья сухие",352,12.3,6.1,59.5],["Овсянка на воде",88,3,1.7,15],["Овсянка на молоке",102,3.2,4.1,14.2],["Пшённая каша на воде",90,3,0.7,17],["Перловка варёная",109,3.1,0.4,22.2],["Булгур сухой",342,12.3,1.3,57.6],["Чечевица сухая",314,24,1.5,48],["Картофель сырой",77,2,0.4,16.3],["Булгур варёный",83,3.1,0.2,18.6],["Киноа варёная",120,4.4,1.9,21.3],["Кускус варёный",112,3.8,0.2,23.2],["Макароны варёные",112,3.5,0.4,23],["Макароны сухие",344,10.4,1.1,71.5],["Картофель отварной",82,2,0.4,16.7],["Картофель запечённый",93,2.5,0.1,21],["Картофельное пюре",106,2.5,4.2,14.7],["Картофель фри",312,3.4,15,41],["Батат запечённый",90,2,0.2,20.7],["Хлеб цельнозерновой",247,13,3.4,41],["Хлеб белый",265,8,3.2,49],["Хлеб ржаной",210,6.7,1.2,42],["Батон нарезной",264,7.5,2.9,50.9],["Хлебцы цельнозерновые",300,11,3,57],["Лаваш тонкий",275,9,1,56],["Мука пшеничная",334,10.3,1.1,70],["Мюсли",352,10,6,64],["Гранола",471,10,20,64],["Кукурузные хлопья",357,7,1,83],["Куриная грудка сырая",113,23.6,1.9,0.4],["Куриная грудка отварная",137,29.8,1.8,0.5],["Куриная грудка жареная",165,31,3.6,0],["Куриное бедро без кожи сырое",121,19.7,4.1,0],["Куриное бедро с кожей запечённое",229,23,15,0],["Фарш куриный",143,17.4,8.1,0],["Индейка филе сырое",114,23.7,1.5,0],["Индейка филе запечённая",150,29,4,0],["Говядина постная сырая",158,22.2,7.1,0],["Говядина отварная",254,25.8,16.8,0],["Фарш говяжий",215,18.6,15,0],["Телятина",97,19.7,1.2,0],["Свинина вырезка сырая",143,21,6,0],["Свинина жареная",260,25,17,0],["Печень куриная",137,20.4,5.9,0.7],["Печень говяжья",127,17.9,3.7,5.3],["Колбаса варёная",257,13,22,1.5],["Колбаса сырокопчёная",461,24,40.5,0],["Ветчина",270,14,24,0],["Сосиски молочные",266,11,23.9,1.6],["Бекон жареный",541,37,42,1.4],["Лосось сырой",208,20,13,0],["Лосось запечённый",200,22,12,0],["Сёмга слабосолёная",202,22.5,12.5,0],["Треска",78,17.7,0.7,0],["Минтай",72,15.9,0.9,0],["Хек",86,16.6,2.2,0],["Скумбрия",191,18,13.2,0],["Сельдь солёная",217,19.8,15.4,0],["Тунец в собственном соку",96,21,1,0],["Креветки варёные",99,24,0.3,0.2],["Кальмар варёный",110,18,2.2,2],["Крабовые палочки",73,6,1,10],["Яйцо куриное",157,12.7,11.5,0.7],["Белок яичный",44,11.1,0,0],["Желток яичный",352,16.2,31.2,1],["Яйцо перепелиное",168,11.9,13.1,0.6],["Омлет",184,9.6,15.4,1.9],["Творог 0%",71,16.5,0.5,1.3],["Творог 5%",121,17.2,5,1.8],["Творог 9%",159,16.7,9,2],["Зернёный творог 5%",105,12,5,2],["Сыр творожный",230,7,21,3],["Молоко 1,5%",45,2.8,1.5,4.7],["Молоко 2,5%",52,2.8,2.5,4.7],["Молоко 3,2%",59,2.9,3.2,4.7],["Кефир 1%",40,3,1,4],["Кефир 2,5%",53,2.9,2.5,4],["Ряженка 4%",67,2.9,4,4.2],["Йогурт греческий 2%",73,10,2,3.6],["Йогурт натуральный 2,5%",60,4.3,2.5,5],["Йогурт питьевой фруктовый",79,2.8,1.5,13],["Сметана 15%",158,2.6,15,3],["Сметана 20%",204,2.5,20,3.4],["Сливки 10%",118,3,10,4],["Сыр твёрдый",356,26,26.5,3.5],["Моцарелла",280,22,21,2],["Фета",264,14,21,4],["Брынза",260,17.9,20.1,0],["Пармезан",392,35.8,25.8,3.2],["Сыр плавленый",257,16.8,11.2,23.8],["Масло сливочное 82%",748,0.5,82.5,0.8],["Протеин сывороточный (сухой)",380,75,5,8],["Огурец",15,0.8,0.1,2.8],["Помидор",20,1.1,0.2,3.7],["Помидоры черри",24,1,0.2,4],["Капуста белокочанная",27,1.8,0.1,4.7],["Капуста пекинская",16,1.2,0.2,2],["Капуста цветная",30,2.5,0.3,4.2],["Брокколи",34,2.8,0.4,6.6],["Капуста брюссельская",43,3.4,0.3,8.9],["Морковь",35,1.3,0.1,6.9],["Свёкла варёная",44,1.7,0.2,10],["Лук репчатый",41,1.4,0.2,8.2],["Лук зелёный",20,1.3,0.1,3.2],["Чеснок",149,6.5,0.5,30],["Перец болгарский",26,1.3,0.1,5.3],["Кабачок",24,0.6,0.3,4.6],["Баклажан",24,1.2,0.1,4.5],["Тыква",22,1,0.1,4.4],["Шпинат",23,2.9,0.3,2],["Салат листовой",14,1.2,0.3,1.3],["Руккола",25,2.6,0.7,2.1],["Сельдерей стебель",13,0.9,0.1,2.1],["Редис",19,1.2,0.1,3.4],["Фасоль стручковая",24,2,0.2,3.6],["Шампиньоны",27,4.3,1,0.1],["Кукуруза консервированная",80,2.5,1,15],["Горошек зелёный консервированный",55,3.1,0.2,10.5],["Авокадо",160,2,14.7,1.8],["Оливки",145,1,15,4],["Фасоль варёная",123,7.8,0.5,21.5],["Чечевица варёная",116,9,0.4,20],["Нут варёный",139,8.9,2.6,19],["Горох варёный",118,8.3,0.4,21],["Тофу",76,8,4.8,1.9],["Хумус",166,7.9,9.6,14.3],["Яблоко",47,0.4,0.4,9.8],["Груша",47,0.4,0.3,10.3],["Банан",96,1.5,0.2,21.8],["Апельсин",43,0.9,0.2,8.1],["Мандарин",38,0.8,0.2,7.5],["Грейпфрут",35,0.7,0.2,6.5],["Лимон",34,0.9,0.1,3],["Киви",47,1,0.5,10.3],["Виноград",72,0.6,0.2,15.4],["Персик",45,0.9,0.1,9.5],["Абрикос",44,0.9,0.1,9],["Слива",49,0.8,0.3,9.6],["Ананас",52,0.4,0.1,11.5],["Манго",60,0.8,0.4,15],["Арбуз",27,0.6,0.1,5.8],["Дыня",35,0.6,0.3,7.4],["Хурма",67,0.5,0.4,15.3],["Гранат",72,0.7,0.6,14.5],["Клубника",41,0.8,0.4,7.5],["Черника",44,1.1,0.4,7.6],["Малина",46,0.8,0.5,8.3],["Вишня",52,0.8,0.2,10.6],["Смородина чёрная",44,1,0.4,7.3],["Финики",282,2.5,0.4,69],["Курага",232,5.2,0.3,51],["Изюм",264,2.9,0.6,66],["Чернослив",231,2.3,0.7,57.5],["Орехи грецкие",654,15.2,65.2,7],["Миндаль",609,18.6,53.7,13],["Фундук",651,15,61.5,9.4],["Кешью",600,18.5,48.5,22.5],["Арахис",552,26.3,45.2,9.9],["Фисташки",556,20,50,7],["Семечки подсолнечника",601,20.7,52.9,10.5],["Семена чиа",486,17,31,42],["Семена льна",534,18.3,42.2,1.6],["Кунжут",565,19.4,48.7,12.2],["Арахисовая паста",588,25,50,20],["Масло оливковое",898,0,99.8,0],["Масло подсолнечное",899,0,99.9,0],["Майонез 67%",627,0.8,67,2.6],["Кетчуп",93,1.8,1,22],["Соевый соус",53,6,0,6.6],["Горчица",162,9.9,12.7,5.3],["Сахар",398,0,0,99.7],["Мёд",329,0.8,0,81.5],["Варенье",265,0.4,0.3,68],["Шоколад тёмный 70%",540,7.8,35,46],["Шоколад молочный",550,6.9,35.7,54.4],["Печенье овсяное",437,6.5,14.4,71.8],["Печенье сахарное",417,7.5,9.8,74.4],["Зефир",304,0.8,0.1,79.8],["Мороженое пломбир",232,3.2,15,20.8],["Халва",516,11.6,29.7,54],["Круассан",406,8.2,21,45.8],["Чипсы картофельные",536,6.6,34,53],["Кофе без сахара",2,0.1,0,0],["Капучино",40,2.2,2,3.3],["Латте",45,2.4,1.9,4],["Чай без сахара",1,0,0,0.2],["Сок апельсиновый",45,0.7,0.2,10.4],["Кола",42,0,0,10.6],["Молоко овсяное",46,1,1.5,7],["Пиво светлое",43,0.5,0,3.6],["Вино сухое",68,0.1,0,2.6],["Пельмени",275,11.9,12.4,29],["Пицца",266,11,10,33],["Борщ",49,1.1,2.2,6.7],["Гамбургер",254,13,11,26],["Блины",233,6.1,12.3,26],["Салат оливье",198,5.5,16.5,6.6],["Куриные крылья сырые",186,19.2,12.2,0],["Куриные крылья запечённые",254,23.8,16.9,0],["Куриные крылья жареные",290,26.9,19.5,0],["Куриные голени сырые",158,18,9.5,0],["Куриные голени запечённые",210,24,12.5,0],["Куриное бедро с кожей сырое",211,17.3,15.3,0],["Куриное бедро без кожи запечённое",179,24.8,8.2,0],["Курица (тушка) сырая",190,16,14,0],["Курица гриль",210,24,12.5,0],["Куриные сердечки",159,15.8,10.3,0.8],["Куриные желудки",114,18.2,4.2,0.6],["Куриная грудка копчёная",117,26.6,1.2,0],["Куриные наггетсы",296,15,19,15],["Котлета куриная",190,18,10,7],["Шашлык из курицы",165,22,8,1],["Индейка бедро сырое",144,19.5,7,0],["Фарш индейки",150,18.7,8.3,0],["Котлета из индейки",160,18,8,5],["Утка запечённая",337,19,28.4,0],["Кролик",183,21,11,0],["Баранина",209,15.6,16.3,0],["Фарш говяжий постный 5%",137,21.4,5,0],["Говяжья вырезка сырая",158,20.2,8.5,0],["Стейк говяжий жареный",220,28,12,0],["Говядина тушёная",232,16.8,18.3,0],["Язык говяжий отварной",231,23.9,15,0],["Сердце говяжье",96,16,3.5,2],["Печень свиная",109,18.8,3.6,0],["Свиная шея сырая",267,16,22.5,0],["Свиная корейка сырая",181,21,11,0],["Свиные рёбра сырые",277,15.5,23.4,0],["Фарш свино-говяжий",263,17,22,0],["Шашлык из свинины",324,22.5,25.6,0],["Сало",797,2.4,89,0],["Буженина",225,15,18,0],["Карбонад",135,16,8,0],["Колбаса докторская",257,12.8,22.2,1.5],["Колбаса полукопчёная",360,16,33,0],["Сардельки",251,10.1,23.1,0.5],["Сосиски куриные",226,12,19,2],["Паштет печёночный",301,12,26.8,2.3],["Хамон",241,30.5,13.2,0],["Пепперони",504,19,46,1],["Тушёнка говяжья",220,14.5,17.5,0],["Котлета говяжья",260,16,18,10],["Котлета по-киевски",315,15,24,9],["Горбуша",140,20.5,6.5,0],["Горбуша запечённая",169,24.6,7.3,0],["Кета",127,19,5.6,0],["Форель",141,19.2,6.6,0],["Форель слабосолёная",186,21,11,0],["Лосось копчёный",117,18.3,4.3,0],["Скумбрия холодного копчения",221,23.4,13.1,0],["Скумбрия горячего копчения",225,20.7,15.5,0],["Сельдь свежая",158,17.7,9.7,0],["Тилапия",96,20,1.7,0],["Судак",84,18.4,1.1,0],["Щука",84,18.4,1.1,0],["Карп",112,16,5.3,0],["Окунь морской",117,18.2,3.3,0],["Камбала",83,15.7,3,0],["Дорадо",96,18,3,0],["Сибас",97,18,3,0],["Палтус",102,18.6,3,0],["Пангасиус",89,15.2,2.9,0],["Тунец стейк сырой",110,23.4,1,0],["Сайра в масле",283,18.3,23.3,0],["Шпроты в масле",363,17.4,32.4,0.4],["Сардины в масле",220,24,13.9,0],["Печень трески",613,4.2,65.7,1.2],["Икра красная",252,24.6,17.3,4],["Мидии",77,11.5,2,3.3],["Мидии варёные",172,24,4.5,7.4],["Осьминог",82,15,1,2.2],["Креветки сырые",85,20.1,0.5,0],["Креветки королевские варёные",87,18.9,1.1,0],["Морской коктейль",124,17.4,3.6,3],["Кальмар сырой",92,15.6,1.4,3.1],["Морская капуста",25,0.9,0.2,3],["Рыба в кляре",230,13,13,15],["Яйцо варёное",155,12.6,10.6,1.1],["Яичница",196,13.6,15.3,0.9],["Молоко 0,5%",35,3,0.5,4.9],["Молоко 6% топлёное",84,3,6,4.7],["Молоко безлактозное 1,5%",45,2.8,1.5,4.7],["Молоко соевое",54,3.3,1.8,6],["Молоко миндальное",24,0.5,1.1,3],["Молоко сгущённое",320,7.2,8.5,55.5],["Кефир 0%",30,3,0.1,3.8],["Кефир 3,2%",59,2.9,3.2,4],["Ряженка 2,5%",54,2.9,2.5,4.2],["Простокваша 2,5%",53,2.9,2.5,4.1],["Айран",27,1.1,1.5,1.4],["Снежок",82,2.8,2.5,12],["Йогурт греческий 0%",59,10.2,0.4,3.6],["Йогурт греческий 5%",97,9,5,3.5],["Скир",63,11,0.2,4],["Творог 2%",103,18,2,3.3],["Творог 18%",236,15,18,2.8],["Творожная масса сладкая",341,7.1,23,27.5],["Сырок глазированный",407,8.5,27.8,32],["Творожок фруктовый",120,8,4,13],["Сметана 10%",115,3,10,2.9],["Сметана 25%",248,2.6,25,2.5],["Сливки 20%",205,2.8,20,3.7],["Сливки 33%",322,2.2,33,3],["Сыр сливочный (крем-чиз)",342,6,34,4],["Сыр Российский",364,23.2,29.5,0],["Сыр Гауда",356,25,27.4,2.2],["Сыр Эдам",357,25,27.8,1.4],["Сыр Чеддер",403,24.9,33.1,1.3],["Сыр Голландский",352,26,26.8,0],["Сыр Сулугуни",288,20,24,0],["Сыр Адыгейский",240,18.5,14,1.5],["Рикотта",174,11.3,13,3],["Маскарпоне",412,4.6,41.5,4.8],["Камамбер",300,19.8,24.3,0.5],["Сыр с плесенью (дор блю)",354,21,30,0],["Халуми",321,21,26,2],["Сыр колбасный копчёный",270,23,19,0],["Сыр твёрдый лёгкий 15–17%",260,30,16,0],["Масло сливочное 72,5%",661,0.8,72.5,1.3],["Масло топлёное (гхи)",892,0.3,99,0.6],["Молочный коктейль",89,3,2,14],["Рис басмати сухой",349,7.9,0.6,77],["Рис бурый сухой",337,7.4,1.8,72.9],["Рис дикий сухой",357,14.7,1.1,75],["Пшено сухое",348,11.5,3.3,66.5],["Перловка сухая",315,9.3,1.1,66.9],["Ячневая крупа сухая",313,10,1.3,65.4],["Ячневая каша на воде",76,2.3,0.3,15.6],["Манная крупа",333,10.3,1,70.6],["Манная каша на молоке",98,3,3.2,15.3],["Кукурузная крупа",337,8.3,1.2,71],["Кукурузная каша на воде",86,2,0.3,18.7],["Рисовая каша на молоке",97,2.9,3.2,14.3],["Пшённая каша на молоке",120,4,3.5,18],["Киноа сухая",368,14.1,6.1,64.2],["Кускус сухой",376,12.8,0.6,77.4],["Полба сухая",338,14.6,2.4,70],["Гречка зелёная сухая",310,13,3.4,62],["Овсяные хлопья быстрого приготовления",360,12,6,61],["Овсяные отруби",246,17.3,7,50.8],["Отруби пшеничные",216,15.6,4.3,21.8],["Лапша гречневая сухая",336,14.4,0.7,71.5],["Лапша рисовая сухая",364,6,0.6,80],["Лапша яичная сухая",384,14,4.4,71],["Лапша быстрого приготовления",450,9,20,58],["Макароны цельнозерновые сухие",348,13.9,2.5,63],["Макароны цельнозерновые варёные",124,5.3,0.5,26.5],["Вареники с картофелем",148,4.4,3.4,25.3],["Вареники с творогом",203,11,4,30],["Манты",190,9,9,18],["Хинкали",205,10,9,21],["Мука ржаная",304,8.9,1.7,61.8],["Мука цельнозерновая",340,13.2,2.5,61.3],["Мука рисовая",366,6,1.4,80],["Мука кукурузная",330,7.2,1.5,72],["Мука миндальная",571,21,50,10],["Крахмал кукурузный",343,1,0.6,85],["Картофель жареный",192,2.8,9.5,23.4],["Картофель по-деревенски",160,2.5,8,19],["Драники",220,4,13,22],["Хлеб бородинский",208,6.8,1.3,40.7],["Хлеб отрубной",227,7.5,1.3,45.2],["Багет",262,7.5,2.9,51.4],["Чиабатта",271,7.8,3.8,50],["Тортилья пшеничная",312,8.3,8,52],["Пита",275,9.1,1.2,55.7],["Хлебцы ржаные",310,11,2.7,58],["Хлебцы рисовые",380,8,3,79],["Сухари панировочные",347,9.7,1.9,77.6],["Сушки",339,11,1.3,73],["Крекер",440,10,17,63],["Булочка сдобная",339,7.6,9.4,55.5],["Булочка для бургера",279,9.5,4.3,50.5],["Оладьи",233,6.4,7.7,34.5],["Сырники",220,15,10,19],["Блинчики с творогом",210,11,9,21],["Блинчики с мясом",230,10,12,20],["Пирожок жареный с капустой",230,5,10,30],["Пирожок печёный с яблоком",250,5,7,42],["Чебурек",290,9,18,24],["Хачапури",290,11,14,31],["Капуста краснокочанная",31,1.4,0.2,6],["Капуста квашеная",23,1.8,0.1,3],["Капуста тушёная",75,2,3.4,9.6],["Капуста савойская",28,1.2,0.1,6.1],["Кольраби",44,2.8,0.1,7.9],["Огурец солёный",11,0.8,0.1,1.7],["Огурец маринованный",16,0.8,0.1,3],["Помидоры в собственном соку",20,1.1,0.1,3.5],["Томатная паста",82,4.8,0.5,16],["Помидоры вяленые в масле",213,5,14,23],["Морковь варёная",35,0.8,0.2,8.2],["Морковь по-корейски",134,1.2,10,9],["Свёкла сырая",42,1.5,0.1,8.8],["Лук-порей",33,2,0,6.3],["Лук красный",42,1.4,0.1,9],["Имбирь",80,1.8,0.8,15.8],["Перец чили",40,1.9,0.4,8.8],["Цукини",17,1.2,0.3,3.1],["Патиссон",19,0.6,0.1,4.1],["Баклажан запечённый",35,0.8,0.2,8.7],["Спаржа",20,2.2,0.1,3.9],["Сельдерей корень",32,1.3,0.3,6.5],["Пастернак",47,1.4,0.5,9.2],["Репа",28,1.5,0.1,6.2],["Редька",36,1.9,0.2,6.7],["Дайкон",21,1.2,0,4.1],["Топинамбур",61,2.1,0.1,12.8],["Укроп",38,2.5,0.5,6.3],["Петрушка",49,3.7,0.4,7.6],["Кинза",23,2.1,0.5,1.9],["Базилик",23,3.2,0.6,2.7],["Щавель",22,1.5,0.3,2.9],["Салат айсберг",14,0.9,0.1,1.8],["Салат романо",17,1.2,0.3,3.3],["Микс салатов",17,1.5,0.2,2.5],["Батат сырой",86,1.6,0.1,20.1],["Кукуруза варёная",96,3.4,1.5,21],["Горошек зелёный замороженный",77,5,0.2,13.8],["Фасоль красная консервированная",99,6.7,0.3,17.4],["Фасоль в томатном соусе",87,5,0.3,15],["Овощная смесь замороженная",41,2,0.3,7],["Брокколи варёная",35,2.4,0.4,7.2],["Капуста цветная варёная",23,1.8,0.3,4],["Вешенки",33,3.3,0.4,6.1],["Грибы белые",34,3.7,1.7,1.1],["Лисички",19,1.5,1,1],["Опята",22,2.2,1.2,0.5],["Шампиньоны жареные",50,3.9,3,2],["Грибы маринованные",24,2.2,0.4,1.8],["Маслины",166,1,15,6],["Салат овощной с маслом",60,1,4.5,4],["Фасоль сухая",298,21,2,47],["Нут сухой",364,19,6,61],["Горох сухой",298,20.5,2,49.5],["Маш сухой",300,23.5,2,46],["Эдамаме",121,11.9,5.2,8.9],["Тофу твёрдый",144,17.3,8.7,2.8],["Соевое мясо сухое",296,52,1,17],["Фалафель",333,13.3,17.8,31.8],["Арахис жареный солёный",585,24,49.7,15],["Пекан",691,9.2,72,4.3],["Бразильский орех",656,14.3,66.4,4.8],["Макадамия",718,7.9,75.8,5.2],["Кедровые орехи",673,13.7,68.4,9.4],["Семена тыквы",559,30.2,49,10.7],["Кокосовая стружка",592,6.3,57,6.6],["Тахини",595,17,53.8,21],["Помело",32,0.6,0.2,6.7],["Лайм",30,0.7,0.2,7.7],["Нектарин",44,1.1,0.3,9.6],["Черешня",50,1.1,0.4,10.6],["Голубика",39,1,0.5,6.6],["Ежевика",34,1.5,0.5,4.4],["Клюква",28,0.5,0.2,3.7],["Брусника",46,0.7,0.5,8.2],["Крыжовник",44,0.7,0.2,9.1],["Смородина красная",43,0.6,0.2,7.7],["Облепиха",82,1.2,5.4,5.7],["Инжир свежий",74,0.8,0.3,19.2],["Инжир сушёный",257,3.1,0.8,57.9],["Фейхоа",49,1,0,11],["Папайя",43,0.5,0.3,10.8],["Маракуйя",97,2.2,0.7,13.4],["Личи",66,0.8,0.4,16.5],["Айва",40,0.6,0.5,9.6],["Кокос (мякоть)",354,3.3,33.5,6.2],["Банановые чипсы",519,2.3,33.6,58.4],["Клюква сушёная",308,0.1,1.1,82],["Ягодная смесь замороженная",40,0.8,0.3,8],["Шоколад горький 85%",580,10,46,25],["Шоколад белый",541,4.2,30.4,62.2],["Конфеты шоколадные",535,4.8,32,56],["Мармелад",321,0.1,0.1,79.4],["Пастила",324,0.5,0,80.4],["Карамель",375,0,0.1,93],["Ирис",423,3.3,7.5,81.8],["Вафли с начинкой",530,3.5,30,62],["Галеты",393,11,9.7,66],["Пряник",364,4.8,2.8,77.7],["Торт бисквитный с кремом",344,4.7,20,37],["Торт Наполеон",400,5,24,41],["Торт Медовик",440,6,23,52],["Чизкейк",321,5.5,22.5,25.5],["Эклер",262,6.4,15.7,23.5],["Кекс",389,6,16,55],["Маффин шоколадный",420,6,22,50],["Пончик",452,5,25,51],["Шоколадно-ореховая паста",539,6.3,30.9,57.5],["Протеиновый батончик",350,30,10,35],["Батончик мюсли",400,6,15,60],["Попкорн",401,12.9,4.5,77.9],["Сухарики (снеки)",420,10,15,63],["Мороженое сливочное",186,3.5,10,19.8],["Мороженое эскимо",270,3.5,18,22],["Желе фруктовое",70,1.5,0,16],["Сироп кленовый",260,0,0.1,67],["Сироп топинамбура",267,2,0,65],["Сахар коричневый",380,0,0,98],["Какао-порошок",289,24.3,15,10.2],["Желатин",355,87.2,0.4,0.7],["Квас",27,0.2,0,5.2],["Компот",60,0.2,0,15],["Морс ягодный",40,0.1,0,10],["Сок яблочный",46,0.1,0.1,11.3],["Сок томатный",18,0.9,0.1,3.5],["Сок мультифрукт",48,0.5,0.1,11],["Смузи фруктовый",55,0.6,0.2,12.5],["Какао на молоке",85,3.2,3.8,10],["Раф",120,2.5,7,11],["Флэт уайт",50,2.8,2.6,4],["Лимонад",40,0,0,10],["Энергетик",45,0,0,11],["Кола без сахара",0,0,0,0],["Комбуча",17,0,0,4],["Вино полусладкое",78,0.2,0,2.5],["Шампанское брют",75,0.2,0,1.5],["Пиво тёмное",48,0.3,0,5.7],["Пиво безалкогольное",26,0.2,0,5.2],["Сидр",42,0,0,5],["Водка",235,0,0,0.1],["Коньяк",239,0,0,0.1],["Виски",235,0,0,0],["Масло кокосовое",899,0,99.9,0],["Масло льняное",898,0,99.8,0],["Майонез лёгкий 30%",299,0.5,30,6],["Соус песто",430,5,44,5],["Соус барбекю",172,0.8,0.6,40.8],["Соус терияки",89,5.9,0,15.6],["Соус Цезарь",420,2,44,4],["Соус тартар",300,1,30,6],["Соус томатный для пасты",50,1.5,1.5,8],["Аджика",59,1,3.7,5.8],["Хрен",56,3.2,0.4,10.5],["Гуакамоле",160,2,14.7,8.5],["Плов с курицей",150,7,5.5,18],["Плов со свининой",200,7,9,22],["Гречка по-купечески",156,9,6,16],["Макароны по-флотски",205,10,9,21],["Лазанья",165,9,8,15],["Спагетти болоньезе",140,7,5,17],["Паста карбонара",230,9,11,23],["Голубцы",105,6,5,9],["Перец фаршированный",95,5,4,9],["Жаркое с мясом и картофелем",140,8,7,11],["Солянка",69,4.5,4.3,3],["Щи",31,1,1.8,3],["Рассольник",42,1.2,1.9,5],["Суп гороховый",66,4.4,2.4,6.9],["Суп грибной",35,1.5,1.6,3.8],["Суп-лапша куриный",45,3,1.5,5],["Уха",46,4.8,1.5,3],["Окрошка на кефире",53,3,2.2,5],["Крем-суп грибной",75,1.8,5,5.5],["Суп Том ям",55,4,2.5,3],["Мисо-суп",30,2,1,3],["Салат Цезарь с курицей",190,9,13,9],["Салат Греческий",115,3.5,10,3.5],["Салат Мимоза",210,7,18,4],["Сельдь под шубой",190,5,15,8],["Винегрет",76,1.6,4.6,6.7],["Салат крабовый",190,6,14,10],["Шаурма с курицей",230,10,12,21],["Чизбургер",263,13.2,11.7,27],["Хот-дог",247,9.7,14.5,18.4],["Роллы Филадельфия",175,7,5.5,24],["Роллы Калифорния",160,5,5,23],["Суши с лососем",160,7,3,25],["Пицца Маргарита",240,10,9,30],["Пицца пепперони",285,12,13,30],["Тефтели в соусе",140,8,8,9],["Сэндвич с курицей",220,12,8,25],["Боул с курицей",140,9,4,17],["Поке с лососем",150,8,5,18],["Пад тай",175,8,7,20],["Рис жареный с овощами",165,3.5,6,24],["Лапша вок с курицей",150,8,5,19],["Курица в кисло-сладком соусе",190,12,8,18],["Карри с курицей",140,11,7,8]];
const nrm = t => String(t || "").toLowerCase().replace(/ё/g, "е");
const stems = t => nrm(t).split(/[^a-zа-я0-9%]+/).filter(w => w.length >= 3).map(w => w.slice(0, Math.max(3, Math.min(5, w.length - 1))));
function foodCandidates(text, custom) {
  const ws = stems(text); if (!ws.length) return [];
  const all = custom.map(f => [f.name, f.kcal, f.p, f.f, f.c, true]).concat(BASE_FOODS);
  const scored = [];
  for (const f of all) {
    const fs = stems(f[0]); let hit = 0;
    for (const a of fs) if (ws.some(w => w.startsWith(a) || a.startsWith(w))) hit++;
    if (hit) scored.push([hit * 10 - fs.length + (f[5] ? 5 : 0), f]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 45).map(x => x[1]);
}
/* числа, которые человек назвал сам, важнее оценки ИИ */
function userNumbers(text, items) {
  if (items.length !== 1) return;
  const t = nrm(text).replace(/(\d),(\d)/g, "$1.$2").replace(/(на|в|per)\s*100\s*(г|гр|грамм\S*)/g, "на сто");
  const k = t.match(/(\d+(?:\.\d+)?)\s*(?:ккал|кк(?![а-я])|килокалори|калори|кал(?![а-я]))/);
  const g = t.match(/(\d+(?:\.\d+)?)\s*(?:г(?![а-я])|гр(?![а-я])|грамм)/);
  if (g) items[0].g = Math.max(1, Math.round(+g[1]));
  if (k) {
    const K = +k[1], total = /(всего|итого|на порцию|за порцию|за вс[её]|на весь|на всю)/.test(t);
    items[0].kcal = total && items[0].g ? Math.round(K / items[0].g * 1000) / 10 : K;
    items[0].userKcal = true;
  }
  for (const [re, key] of [[/белк[а-я]*\s*:?\s*(\d+(?:\.\d+)?)/, "p"], [/жир[а-я]*\s*:?\s*(\d+(?:\.\d+)?)/, "f"], [/углевод[а-я]*\s*:?\s*(\d+(?:\.\d+)?)/, "c"]]) {
    const m = t.match(re); if (m) items[0][key] = +m[1];
  }
}
const FOOD_TEXT_PROMPT = (dishes, cands) => `Ты — нутрициолог в дневнике питания. Пользователь написал в чат, что съел. Разбери сообщение на отдельные продукты и блюда.
— ВАЖНО: если пользователь сам назвал калорийность («хлеб 265 ккал», «265 калорий», «с упаковки 265») — это калории НА 100 г продукта: ставь ровно это число в kcal. Если сказано «всего N ккал», «на порцию N ккал» — это калории на весь указанный вес: kcal = N / граммы × 100. То же для белков, жиров и углеводов. Названные пользователем цифры важнее справочника и твоей оценки.
— Если продукт совпадает с позицией справочника ниже — бери её название и значения.
— Вес: если указан — используй его. Если указаны штуки, ложки, стаканы, «тарелка», «порция» — переведи в граммы по типичным размерам (1 яйцо ≈ 55 г, 1 котлета ≈ 80 г, тарелка супа ≈ 300 г, порция гарнира ≈ 150 г, ч. л. сахара ≈ 5 г). Если вес не указан — оцени обычную порцию.
— Пищевая ценность — на 100 г продукта в том виде, как его ели (каша варёная, мясо жареное и т.п.).
— Названия по-русски, коротко: «Гречка варёная», «Котлета куриная жареная».
— meal: если в сообщении сказано «на завтрак/обед/ужин/перекус» — укажи "Завтрак", "Обед", "Перекус" или "Ужин", иначе null.
— day_offset: 0 — сегодня; -1 если «вчера»; -2 если «позавчера».
— Если сообщение — это рецепт или список продуктов для готовки (а не то, что человек съел), верни "type":"recipe" и пустой items.
— Если сообщение не про еду — верни пустой items и в note коротко скажи, что ты понимаешь.
${cands.length ? `Справочник (на 100 г: ккал, Б, Ж, У):\n${cands.map(f => `${f[0]}: ${f[1]}, ${f[2]}, ${f[3]}, ${f[4]}`).join("\n")}\n` : ""}${dishes.length ? `Свои блюда пользователя (если он упоминает их — используй эти значения и порцию):\n${dishes.map(d => { const s = dishStats(d); return `«${d.name}»: порция ${s.portionG} г, на 100 г ${s.per100.kcal} ккал, Б ${s.per100.p}, Ж ${s.per100.f}, У ${s.per100.c}`; }).join("\n")}\n` : ""}Ответь ТОЛЬКО JSON без пояснений:
{"type":"food","meal":null,"day_offset":0,"items":[{"name":"...","grams":число,"kcal":число,"p":число,"f":число,"c":число,"fb":число}],"note":""}
fb — клетчатка, г на 100 г (0, если её нет: мясо, рыба, молочное, яйца).`;

async function botFoodText(env, uid, s, textIn, viaVoice) {
  const dishes = (await userDishes(env, uid)).slice(0, 40);
  const cf = await kget(env, `u:${uid}:d:foods`), custom = (cf && cf.v && cf.v.items) || [];
  const j = await claudeJSON(env, uid, [{ type: "text", text: FOOD_TEXT_PROMPT(dishes, foodCandidates(textIn, custom)) + `\n\nСообщение пользователя: «${String(textIn).slice(0, 1500)}»` }]);
  if (j.type === "recipe") return botRecipe(env, uid, String(textIn), null);
  const items = (j.items || []).filter(x => x && x.name).map(x => ({ name: String(x.name).slice(0, 80), g: Math.max(1, Math.round(+x.grams || 100)), kcal: +x.kcal || 0, p: +x.p || 0, f: +x.f || 0, c: +x.c || 0, ...(x.fb != null && !isNaN(+x.fb) ? { fb: r1(+x.fb) } : {}) }));
  if (!items.length) {
    await send(env, uid, `${viaVoice ? `🎙 Услышала: «${esc(textIn)}»\n\n` : ""}${esc(j.note || "Не поняла, что записать.")}\n\nНапиши, что ты съела, например: «на обед 150 г гречки и котлета» — и я запишу в дневник. Можно голосовым или фото тарелки. А ссылку на рецепт я сохраню как блюдо.`, { reply_markup: openBtn(env) });
    return;
  }
  userNumbers(textIn, items);
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
  if (isMenuCaption(m.caption)) return botCafe(env, uid, s, b64(bytes), m.caption);
  const res = await aiPhoto(env, { id: uid }, { image: b64(bytes), mime: "image/jpeg", hint: m.caption || "" });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  if (j.menu) return botCafe(env, uid, s, b64(bytes), m.caption);
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

/* ---------------- «Что съесть?», меню в кафе, разбор недели ---------------- */
async function dayLeft(env, uid, s) {
  const date = localDate(new Date(), s.tz);
  const sum = (await kget(env, `d:${uid}:${date}`)) || {};
  const cur = await kget(env, `u:${uid}:d:d-${date}`);
  const eaten = cur && cur.v ? totalsOf(cur.v.meals || []) : { kcal: sum.kcal || 0, p: sum.p || 0, f: sum.f || 0, c: sum.c || 0 };
  const norm = (sum.norm || 0) + (sum.burn || 0);
  return { date, norm, eaten, left: norm ? Math.round(norm - eaten.kcal) : null, meal: autoMeal(localNow(new Date(), s.tz).getUTCHours()) };
}
const leftLine = d => d.left == null ? "Норма пока не посчитана — заполни профиль в дневнике." : d.left >= 0 ? `Осталось на сегодня: <b>${fmt(d.left)} ккал</b>` : `Сегодня уже перебор на ${fmt(-d.left)} ккал`;

const SUGGEST_PROMPT = (d, pantry, dishes, ask) => `Ты — нутрициолог в дневнике питания. Предложи 3 варианта, что съесть сейчас (${d.meal.toLowerCase()}).
${d.left != null ? `На сегодня осталось ${d.left} ккал (съедено ${Math.round(d.eaten.kcal)}, Б ${Math.round(d.eaten.p)}, Ж ${Math.round(d.eaten.f)}, У ${Math.round(d.eaten.c)} г). Уложись в остаток; если остаток маленький или отрицательный — предложи лёгкие варианты до 150–250 ккал.` : "Норма неизвестна — предлагай обычные сбалансированные порции 300–500 ккал."}
${pantry.length ? `Продукты дома (используй их в первую очередь): ${pantry.join(", ")}.` : ""}
${dishes.length ? `Свои блюда пользователя: ${dishes.join(", ")}.` : ""}
Просьба пользователя: «${String(ask).slice(0, 300)}».
Варианты простые, из обычных продуктов, с белком. Названия по-русски.
Ответь ТОЛЬКО JSON: {"options":[{"name":"короткое название","how":"одна фраза: из чего и как приготовить","items":[{"name":"...","grams":число,"kcal":число,"p":число,"f":число,"c":число}]}]}
kcal, p, f, c — на 100 г каждого продукта.`;

async function suggestCore(env, uid, d, ask) {
  const pd = await kget(env, `u:${uid}:d:pantry`), pantry = ((pd && pd.v && pd.v.items) || []).slice(0, 60);
  const dishes = (await userDishes(env, uid)).map(x => x.name).slice(0, 30);
  const j = await claudeJSON(env, uid, [{ type: "text", text: SUGGEST_PROMPT(d, pantry, dishes, ask) + COOK_SENSE + RU_ONLY }], 3000, MODEL_FALLBACK);
  return (j.options || []).filter(o => o && o.name && (o.items || []).length).slice(0, 3).map(o => ({ name: String(o.name).slice(0, 60), how: String(o.how || "").slice(0, 200), items: o.items.filter(x => x && x.name).map(x => ({ name: String(x.name).slice(0, 60), g: Math.max(1, Math.round(+x.grams || 100)), kcal: +x.kcal || 0, p: +x.p || 0, f: +x.f || 0, c: +x.c || 0 })) }));
}
async function botSuggest(env, uid, s, ask) {
  const d = await dayLeft(env, uid, s);
  const opts = await suggestCore(env, uid, d, ask);
  if (!opts.length) { await send(env, uid, "Не получилось придумать варианты — попробуй спросить иначе, например: «что съесть на ужин?»"); return; }
  const tok = rid(10); await kput(env, `sg:${uid}:${tok}`, opts, 60 * 60 * 24);
  const lines = opts.map((o, i) => { const t = totalsOf(o.items); return `<b>${i + 1}. ${esc(o.name)}</b> — ${fmt(t.kcal)} ккал\n${esc(o.how)}\n<i>${o.items.map(x => `${esc(x.name)} ${fmt(x.g)} г`).join(", ")}</i>`; });
  await send(env, uid, `🍽 ${leftLine(d)}\n\n${lines.join("\n\n")}`, { reply_markup: { inline_keyboard: [opts.map((o, i) => ({ text: `Записать ${i + 1}`, callback_data: `sg:${tok}:${i}` }))] } });
}

const MENU_PROMPT = d => `На фото — меню кафе или ресторана. Прочитай блюда и помоги выбрать.
${d.left != null ? `У человека на сегодня осталось ${d.left} ккал.` : ""}
Выбери 3 лучших варианта для худеющего: сытно, с белком, без лишних калорий. Оцени калорийность порции по типичному размеру (или по граммовке из меню, если указана). Добавь один короткий совет, как сэкономить калории (соус отдельно, без хлеба и т.п.).
Названия бери из меню как есть. Ответь ТОЛЬКО JSON:
{"options":[{"name":"блюдо из меню","why":"почему хороший выбор, 1 фраза","grams":число,"kcal":число,"p":число,"f":число,"c":число}],"tip":"совет","note":""}
grams — вес порции; kcal, p, f, c — на 100 г. Если меню не читается — пустой options и в note скажи почему.`;

async function cafeCore(env, uid, d, imgB64, caption) {
  const j = await claudeJSON(env, uid, [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imgB64 } }, { type: "text", text: MENU_PROMPT(d) + RU_ONLY + (caption ? `\nПодпись пользователя: «${String(caption).slice(0, 200)}»` : "") }], 2500, MODEL_FALLBACK);
  const opts = (j.options || []).filter(o => o && o.name).slice(0, 3).map(o => ({ name: String(o.name).slice(0, 70), why: String(o.why || "").slice(0, 160), items: [{ name: String(o.name).slice(0, 70), g: Math.max(1, Math.round(+o.grams || 250)), kcal: +o.kcal || 0, p: +o.p || 0, f: +o.f || 0, c: +o.c || 0 }] }));
  return { opts, tip: String(j.tip || "").slice(0, 300), note: String(j.note || "").slice(0, 300) };
}
async function botCafe(env, uid, s, imgB64, caption) {
  const d = await dayLeft(env, uid, s);
  const { opts, ...j } = await cafeCore(env, uid, d, imgB64, caption);
  if (!opts.length) { await send(env, uid, `Не получилось прочитать меню. ${esc(j.note || "")}\nСфотографируй страницу ровнее и ближе.`); return; }
  const tok = rid(10); await kput(env, `sg:${uid}:${tok}`, opts, 60 * 60 * 24);
  const lines = opts.map((o, i) => `<b>${i + 1}. ${esc(o.name)}</b> — ~${fmt(o.items[0].g / 100 * o.items[0].kcal)} ккал\n${esc(o.why)}`);
  await send(env, uid, `🧾 ${leftLine(d)}\n\nЧто я бы выбрала:\n\n${lines.join("\n\n")}${j.tip ? `\n\n💡 ${esc(j.tip)}` : ""}\n\nКогда закажешь — нажми, и я запишу.`, { reply_markup: { inline_keyboard: [opts.map((o, i) => ({ text: `Записать ${i + 1}`, callback_data: `sg:${tok}:${i}` }))] } });
}
const isSuggestAsk = t => /(что|чего|чем)\s+(бы\s+)?(мне\s+)?(съесть|поесть|покушать|приготовить|перекусить|поужинать|пообедать|позавтракать)|посоветуй.*(ужин|обед|завтрак|перекус|съесть|поесть)|иде[ия].*(ужин|обед|завтрак|перекус)|что на (ужин|обед|завтрак|перекус)\s*\?/i.test(t);
const isMenuCaption = t => /меню|кафе|ресторан|что заказать|заказать/i.test(t || "");

/* --- помощник в приложении: те же функции, что у бота, без истории переписки (поэтому не дороже) --- */
async function aiAssist(env, user, b) {
  const uid = user.id, s = await userSettings(env, uid);
  const d = await dayLeft(env, uid, s);
  if (b.ctx && +b.ctx.norm > 0) { d.norm = Math.round(+b.ctx.norm); d.eaten = { kcal: +b.ctx.kcal || 0, p: +b.ctx.p || 0, f: +b.ctx.f || 0, c: +b.ctx.c || 0 }; d.left = Math.round(d.norm - d.eaten.kcal); }
  if (b.ctx && b.ctx.meal) d.meal = String(b.ctx.meal).slice(0, 20);
  const left = leftLine(d);
  if (b.kind === "cafe") {
    const img = String(b.image || "").replace(/^data:image\/\w+;base64,/, ""); if (!img || img.length > 5_000_000) throw new Error("Нет фото или оно слишком большое");
    const r = await cafeCore(env, uid, d, img, b.text);
    return { kind: "cafe", left, ...r };
  }
  if (b.kind === "review") {
    const today = localDate(new Date(), s.tz), ck = `rvw:${uid}:${today}`;
    let t = await kget(env, ck);
    if (!t) { t = await weekReview(env, uid, today); if (t) await kput(env, ck, t, 60 * 60 * 24); }
    return { kind: "review", text: t || "Для разбора нужно хотя бы 3 дня с записями за последнюю неделю — записывай еду, и я разберу." };
  }
  const q = String(b.text || "").trim().slice(0, 500); if (!q) throw new Error("Пустой вопрос");
  if (b.kind === "suggest" || isSuggestAsk(q)) return { kind: "suggest", left, opts: await suggestCore(env, uid, d, q) };
  const j = await claudeJSON(env, uid, [{ type: "text", text: `Ты — доброжелательный нутрициолог в дневнике питания для худеющих. Ответь на вопрос коротко (2–5 предложений), по делу, на «ты», без морализаторства. Не ставь диагнозы; если вопрос про здоровье серьёзный — посоветуй обратиться к врачу.
${d.left != null ? `Контекст: норма ${d.norm} ккал, съедено сегодня ${Math.round(d.eaten.kcal)} ккал (Б ${Math.round(d.eaten.p)}, Ж ${Math.round(d.eaten.f)}, У ${Math.round(d.eaten.c)} г).` : ""}
Если человек пишет, что он съел, — подскажи, что записать еду можно в Дневнике или написав боту.
Вопрос: «${q}»${RU_ONLY}
Ответь ТОЛЬКО JSON: {"answer":"..."}` }], 700);
  return { kind: "answer", text: String(j.answer || "").slice(0, 1500) };
}

/* --- разбор недели от ИИ --- */
async function weekReview(env, uid, today) {
  const days = [];
  for (let i = 7; i >= 1; i--) {
    const date = addDays(today, -i), sum = await kget(env, `d:${uid}:${date}`), doc = await kget(env, `u:${uid}:d:d-${date}`);
    const meals = (doc && doc.v && doc.v.meals) || [];
    if (!meals.length && !(sum && sum.n)) continue;
    const t = meals.length ? totalsOf(meals) : { kcal: sum.kcal, p: sum.p, f: sum.f, c: sum.c };
    days.push({ date, kcal: Math.round(t.kcal), p: Math.round(t.p), f: Math.round(t.f), c: Math.round(t.c), norm: sum ? (sum.norm || 0) + (sum.burn || 0) : 0, steps: sum && sum.steps || 0, w: sum && sum.w || null, foods: meals.map(m => m.name).slice(0, 12) });
  }
  if (days.length < 3) return null;
  const prompt = `Ты — доброжелательный нутрициолог. Сделай короткий разбор недели питания для человека, который худеет. Пиши на «ты», тепло, без морализаторства, по-русски.
Данные по дням (ккал, Б/Ж/У в г, норма с учётом активности, шаги, вес, что ел):
${days.map(d => `${d.date}: ${d.kcal} ккал из ${d.norm || "?"}; Б ${d.p} Ж ${d.f} У ${d.c}; шаги ${d.steps || "—"}; вес ${d.w || "—"}; ${d.foods.join(", ")}`).join("\n")}
Формат ответа — ТОЛЬКО JSON: {"good":["1–2 пункта, что получилось"],"watch":["1–2 пункта, на что обратить внимание, с цифрами"],"tip":"один конкретный совет на следующую неделю, выполнимый"}`;
  const j = await claudeJSON(env, uid, [{ type: "text", text: prompt + RU_ONLY }], 1500, MODEL_FALLBACK);
  const li = a => (a || []).slice(0, 2).map(x => `• ${esc(String(x))}`).join("\n");
  return `🧑‍⚕️ <b>Разбор недели</b>\n\n<b>Что получилось</b>\n${li(j.good)}\n\n<b>На что обратить внимание</b>\n${li(j.watch)}\n\n<b>Совет на неделю</b>\n${esc(String(j.tip || ""))}`;
}

/* --- цикл: «начались» --- */
async function botCycle(env, uid, s) {
  const date = localDate(new Date(), s.tz), k = `u:${uid}:d:cycle`, cur = await kget(env, k);
  const st = ((cur && cur.v && cur.v.starts) || []).filter(x => Math.abs((Date.parse(x) - Date.parse(date)) / 864e5) > 10);
  st.push(date); st.sort();
  await kput(env, k, { v: { starts: st.slice(-24) }, at: Date.now() });
  let avg = 28; const lens = []; for (let i = 1; i < st.length; i++) { const L = Math.round((Date.parse(st[i]) - Date.parse(st[i - 1])) / 864e5); if (L >= 20 && L <= 45) lens.push(L); }
  if (lens.length) avg = Math.round(lens.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, lens.length));
  const next = addDays(date, avg).split("-").reverse().slice(0, 2).join(".");
  await send(env, uid, `🌸 Отметила: первый день цикла — сегодня.\nСледующие примерно ${next} (цикл ~${avg} дн.).\n\nВ ближайшие дни вес может быть выше обычного из-за воды — это не жир, смотри на тренд за неделю.`, { reply_markup: openBtn(env) });
}

const MENU_SCHEMA = { type: "object", required: ["days"], properties: { days: { type: "array", items: { type: "object", required: ["meals"], properties: { meals: { type: "array", items: { type: "object", required: ["m", "n", "i"], properties: { m: { type: "string", description: "приём пищи" }, n: { type: "string", description: "название блюда" }, r: { type: "string", description: "как приготовить" }, i: { type: "array", description: "продукты: [название, граммы, ккал, белки, жиры, углеводы] на 100 г", items: { type: "array", items: {} } } } } } } } } } };
const COOK_SENSE = "\nЗдравый смысл кухни: свежие огурцы, помидоры, листовой салат и зелень не жарят и не греют — их едят свежими; блюда — такие, как реально едят в России.";
const stripLatin = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === "string" ? v.replace(/\s*\(?\b[A-Za-z][A-Za-z-]{2,}\b\)?/g, "").replace(/\s{2,}/g, " ").trim() : v));
const MENU_PER_DAY = 3, MENU_PER_DAY_OWNER = 10;
async function menuQuota(env, uid, take) {
  const day = new Date().toISOString().slice(0, 10), k = `mn:${uid}:${day}`, used = +(await env.KV.get(k) || 0);
  const owner = (await env.KV.get("owner")) || ((await kget(env, "users", [])) || [])[0];
  const lim = String(owner) === String(uid) ? MENU_PER_DAY_OWNER : MENU_PER_DAY;
  if (!take) return used < lim ? null : `Меню можно составлять до ${lim} раз в день — попробуй завтра. Отдельное блюдо можно заменить вручную.`;
  await env.KV.put(k, String(used + 1), { expirationTtl: 60 * 60 * 30 });
}
/* --- меню на неделю от ИИ --- */
async function aiMenu(env, user, b) {
  const n = Math.round(+b.norm || 0); if (!(n >= 900 && n <= 5000)) throw new Error("Сначала заполни профиль — нужна норма калорий");
  const meals = +b.meals === 3 ? ["Завтрак", "Обед", "Ужин"] : ["Завтрак", "Обед", "Перекус", "Ужин"];
  const days = Math.max(1, Math.min(7, Math.round(+b.days || 7)));
  const pantry = (b.pantry || []).map(String).slice(0, 60), dishes = (b.dishes || []).map(String).slice(0, 30);
  const P = Math.round(+b.p || n * 0.3 / 4), F = Math.round(+b.f || n * 0.3 / 9), C = Math.round(+b.c || n * 0.4 / 4);
  // по 2 дня параллельно — так втрое быстрее, и обед с ужином естественно повторяются 2 дня
  const chunks = []; for (let d = 0; d < days; d += 2) chunks.push(Math.min(2, days - d));
  const used = new Set();
  const one = async (cnt, k) => {
    const prompt = `Ты — нутрициолог. Составь меню на ${cnt === 1 ? "1 день" : "2 дня"} для худеющего человека (это часть недельного меню, кусок №${k + 1} — придумай блюда, отличные от других кусков: ${["курица и крупы", "рыба или индейка и овощи", "говядина или фарш и бобовые", "яйца, творог и запеканки"][k % 4]}).
— Норма в день: ${n} ккал (±5%), белки ~${P} г, жиры ~${F} г, углеводы ~${C} г.
— Приёмы пищи: ${meals.join(", ")}.${cnt === 2 ? " Обед и ужин в оба дня одинаковые (готовишь сразу на два дня), завтраки и перекусы разные." : ""}
— Обычные недорогие продукты из российского супермаркета. ${b.quick ? "Только простые блюда: до 20–30 минут готовки." : ""}
${b.exclude ? `— НЕ использовать: ${String(b.exclude).slice(0, 300)}.` : ""}
${pantry.length ? `— В первую очередь используй продукты, которые есть дома: ${pantry.join(", ")}.` : ""}
${dishes.length ? `— Можно включить одно из своих блюд пользователя (не больше одного на эти дни): ${dishes.join(", ")}. Если включаешь своё блюдо — пиши его составом из продуктов, а не одной строкой.` : ""}
— Продукты с весом в граммах (крупы и макароны — варёные, мясо — готовое) и пищевой ценностью на 100 г. Короткие названия по-русски.
— Для каждого блюда — "r": как приготовить, 1–3 коротких шага в одну строку (до 200 символов).
Ответь ТОЛЬКО компактным JSON: {"days":[{"meals":[{"m":"Завтрак","n":"Овсянка с бананом","r":"Свари овсянку на молоке 5 минут, добавь нарезанный банан.","i":[["Овсянка на молоке",250,102,3.2,4.1,14.2],["Банан",100,96,1.5,0.5,21]]}]}]}
где в "i" каждый продукт — [название, граммы, ккал, белки, жиры, углеводы] на 100 г.`;
    let j = await claudeJSON(env, user.id, [{ type: "text", text: prompt + COOK_SENSE + RU_ONLY }], 4000, null, MENU_SCHEMA);
    if (hasLatin(j) || !(j.days || []).length) {   // повтор той же недорогой моделью; если снова латиница — просто вычищаем её
      try { const j2 = await claudeJSON(env, user.id, [{ type: "text", text: prompt + COOK_SENSE + RU_ONLY + "\nВНИМАНИЕ: ни одного английского слова." }], 4000, null, MENU_SCHEMA); if ((j2.days || []).length) j = j2; } catch (e) { if (!(j.days || []).length) throw e; }
    }
    return stripLatin((j.days || []).slice(0, cnt));
  };
  const settled = await Promise.allSettled(chunks.map((c, k) => one(c, k)));
  if (!settled.some(x => x.status === "fulfilled" && x.value.length)) throw new Error((settled.find(x => x.status === "rejected") || {}).reason?.message || "ИИ не смог составить меню — попробуй ещё раз");
  // если какой-то кусок не удался — повторяем удачные дни, чтобы неделя была заполнена
  const okDays = settled.filter(x => x.status === "fulfilled").flatMap(x => x.value);
  const parts = settled.map((x, k) => x.status === "fulfilled" && x.value.length ? x.value : okDays.slice(0, chunks[k]));
  const toItem = x => Array.isArray(x) ? { name: String(x[0] || "").slice(0, 60), g: Math.max(1, Math.round(+x[1] || 100)), kcal: r1(x[2]), p: r1(x[3]), f: r1(x[4]), c: r1(x[5]) } : { name: String(x.name || "").slice(0, 60), g: Math.max(1, Math.round(+x.grams || 100)), kcal: r1(x.kcal), p: r1(x.p), f: r1(x.f), c: r1(x.c) };
  const out = parts.flat().slice(0, days).map(d => ({ meals: (d.meals || []).map(m => ({ meal: meals.includes(m.m || m.meal) ? (m.m || m.meal) : meals[0], name: String(m.n || m.name || "").slice(0, 70), how: String(m.r || m.how || "").slice(0, 400), items: (m.i || m.items || []).map(toItem).filter(x => x.name) })).filter(m => m.name && m.items.length) }));
  if (!out.length || !out.some(d => d.meals.length)) throw new Error("ИИ не смог составить меню — попробуй ещё раз");
  return { days: out };
}

/* --- общая база рецептов: один раз пишет ИИ, дальше берём из базы для любого числа порций и любого человека --- */
const rnorm = t => String(t || "").toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
async function aiRecipe(env, user, body) {
  const name = String(body.name || "").slice(0, 80);
  const ingL = (body.ing || []).slice(0, 20).map(x => [String(x[0]).slice(0, 60), Math.round(+x[1] || 0)]).filter(x => x[0]);
  const N = Math.max(1, Math.min(10, Math.round(+body.portions || 1)));
  const key = "rcp:" + (await sha(rnorm(name) + "|" + ingL.map(x => rnorm(x[0])).sort().join(","))).slice(0, 24);
  let rc = body.fresh ? null : await kget(env, key); const hit = !!rc;
  if (!rc) {
    const list = ingL.map((x, i) => `${i + 1}. ${x[0]}`).join("\n");
    const j = await claudeJSON(env, user.id, [{ type: "text", text: `Ты — опытный домашний повар. Напиши рецепт блюда «${name}». Ингредиенты (вес в списке — уже ГОТОВОГО продукта):
${list}
Рецепт должен подходить для любого числа порций, поэтому в шагах НЕ пиши граммы и количества — их посчитает приложение. Вместо этого в "take" укажи, во сколько раз больше или меньше нужно взять продукта при покупке/готовке относительно готового веса:
— крупы и макароны указаны варёными: гречка и рис ~0.4, макароны ~0.42, булгур и киноа ~0.35, бобовые ~0.45 — "as": «сухой гречки» и т.п.;
— мясо, птица, рыба указаны готовыми: ~1.35 — "as": «сырого куриного филе» и т.п.;
— остальное (овощи, масло, яйца, молочное) берут как есть — их в "take" не включай.
Правила готовки:
— Свежие овощи и зелень (огурцы, помидоры, листовой салат, редис, перец для салата, зелень) НЕ жарь и не грей: нарежь и подай свежими.
— Масло — для заправки салата или для жарки, по смыслу.
— Шаги такие, как реально готовят дома: время, огонь или температура духовки. Если логично готовить заранее (крупа, мясо) — так и напиши.
— 3–6 шагов, на «ты», коротко.${RU_ONLY}
Ответь ТОЛЬКО JSON: {"time":"30 минут","take":[{"n":1,"k":0.4,"as":"сухой гречки"}],"steps":["..."]}` }], 1500, MODEL_FALLBACK);
    rc = { time: String(j.time || "").slice(0, 40), steps: (j.steps || []).map(x => String(x).slice(0, 300)).slice(0, 8), take: (j.take || []).filter(t => t && +t.n >= 1 && +t.n <= ingL.length && +t.k > 0 && +t.k < 5).map(t => ({ n: rnorm(ingL[Math.round(+t.n) - 1][0]), k: +t.k, as: String(t.as || "").slice(0, 60) })), ing: ingL.map(x => x[0]) };
    if (!rc.steps.length) throw new Error("ИИ не прислал шаги рецепта — попробуй ещё раз");
    await kput(env, key, rc);
  }
  // сколько взять — для этого числа порций (вес в запросе уже на все порции)
  const r5 = g => g >= 100 ? Math.round(g / 10) * 10 : Math.max(5, Math.round(g / 5) * 5);
  const take = (rc.take || []).map(t => { const x = ingL.find(y => rnorm(y[0]) === t.n); return x && x[1] ? `${t.as || x[0]} — ${r5(x[1] * t.k)} г` : null; }).filter(Boolean);
  const steps = (take.length ? [`Возьми: ${take.join(", ")}. Остальное — по списку выше.`] : []).concat(rc.steps);
  return { time: rc.time, steps, cached: hit, N };
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
  if (data.startsWith("sg:")) {
    const [, tok, idx] = data.split(":"), opts = await kget(env, `sg:${uid}:${tok}`), o = opts && opts[+idx];
    if (!o) { await ack("Варианты устарели — спроси ещё раз"); return; }
    await ack("Записываю…");
    await logAndReply(env, uid, await userSettings(env, uid), null, 0, o.items);
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
    if (/^(у меня\s+)?(месячные\s+)?(начались|пошли)(\s+месячные)?[.!\s]*$|^месячные[.!\s]*$/i.test(t)) return await botCycle(env, uid, s);
    if (isSuggestAsk(t)) return await botSuggest(env, uid, s, t);
    return await botFoodText(env, uid, s, t, false);
  } catch (e) {
    await send(env, uid, `Не получилось: ${esc(String(e && e.message || e))}. Попробуй ещё раз чуть позже или запиши в приложении.`, { reply_markup: openBtn(env) });
  }
}

/* ---------------- вступление бота ---------------- */
const BOT_DESC = "Дневник похудения 🌿\n\n🍽 Считает калории и БЖУ: пишешь продукт и граммы — остальное посчитается само\n✍️ Можно писать прямо в чат: «на обед 150 г гречки и котлета» — или голосовым\n🔗 Пришли ссылку на рецепт — сохраню блюдо с калориями\n📷 Еда по фото, штрихкоду и этикетке\n📅 Меню на неделю и список покупок\n⚖️ Вес, прогресс и прогноз до цели\n❤️ Шаги и активность из «Здоровья» на iPhone\n👨‍👩‍👧 Общее меню для семьи\n🔔 Напоминания и итоги дня и недели\n\nНажми «Старт» — и начнём.";
const BOT_SHORT = "Считаю калории по продукту и граммам, фото и штрихкоду. Меню на неделю, вес, шаги и напоминания 🌿";
async function botDescribe(env) {
  if (await env.KV.get("desc:v4")) return;
  await tg(env, "setMyDescription", { description: BOT_DESC });
  await tg(env, "setMyShortDescription", { short_description: BOT_SHORT });
  await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  await env.KV.put("desc:v4", "1");
}
const BOT_COMMANDS = [
  { command: "start", description: "Начать" },
  { command: "help", description: "Что я умею и как записывать еду" },
  { command: "today", description: "Итог сегодняшнего дня" },
  { command: "week", description: "Отчёт за неделю" },
  { command: "review", description: "Разбор недели от ИИ-нутрициолога" },
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

🤔 <b>«Что съесть?»</b> — спроси «что на ужин?», и я предложу 3 варианта под остаток калорий и продукты, которые есть дома.

🧾 <b>Меню в кафе</b> — сфотографируй меню с подписью «что заказать», и я подскажу лучшие блюда под твою норму.

🌸 <b>Цикл</b> — напиши «начались» в первый день месячных, и я буду объяснять скачки веса из-за воды.

🔗 <b>Рецепт по ссылке</b> — пришли ссылку на рецепт с любого сайта, и я сохраню блюдо в «Меню» → «Блюда» с калориями на порцию. Если сайт не открывается — пришли текст рецепта сообщением.

<b>Команды</b>
/today — итог дня
/week — отчёт за неделю
/review — разбор недели от ИИ-нутрициолога (по воскресеньям приходит сам)
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
  if (p === "account/delete") {
    if (body.confirm !== "УДАЛИТЬ") return json({ error: "Нет подтверждения" }, 400);
    return json(await deleteAccount(env, user.id));
  }
  if (p === "logout") { if (user.session) await env.KV.delete(`sess:${user.session}`); return json({ ok: true }); }
  if (p === "ai/photo") return await aiPhoto(env, user, body);
  if (p === "ai/recipe") {
    try { return json(await aiRecipe(env, user, body)); } catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  if (p === "ai/assist") { try { return json(await aiAssist(env, user, body)); } catch (e) { return json({ error: String(e.message || e) }, 502); } }
  if (p === "ai/menu") { try { const q = await menuQuota(env, user.id); if (q) return json({ error: q }, 429); const r = await aiMenu(env, user, body); await menuQuota(env, user.id, true); return json(r); } catch (e) { return json({ error: String(e.message || e) }, 502); } }
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
{"items":[{"name":"...","grams":число,"kcal":число,"p":число,"f":число,"c":число,"fb":число}],"note":"одна короткая фраза: что видно и насколько уверена оценка"}
kcal, p, f, c, fb (клетчатка) — на 100 г. Если еды на фото нет — верни {"items":[],"note":"..."}. Если на фото меню кафе или ресторана (список блюд текстом) — верни {"items":[],"menu":true}`;

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
  out.items = (out.items || []).filter(x => x && x.name).map(x => ({ name: String(x.name).slice(0, 80), grams: Math.max(1, Math.round(+x.grams || 100)), kcal: +x.kcal || 0, p: +x.p || 0, f: +x.f || 0, c: +x.c || 0, ...(x.fb != null && !isNaN(+x.fb) ? { fb: +x.fb } : {}) }));
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
      if (s.weekly.on && dow === 0 && slot(s.weekly.time) === hm) { const wt = await weekText(env, uid, today); if (!wt.includes("записей нет")) { await send(env, uid, wt, { reply_markup: openBtn(env) }); try { const rv = await weekReview(env, uid, addDays(today, 1)); if (rv) await send(env, uid, rv); } catch (e) {} } }
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
