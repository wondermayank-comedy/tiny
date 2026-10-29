// ThunderStudy Group Bot — Cloudflare Worker (webhook)
// Auto-replies (cuet / mock / notes / english / contact / ai) + mutes for links & "dm" spam.

// ───────────────────────── CONFIG (edit here) ─────────────────────────
const CONFIG = {
  MUTE_HOURS: 24, // can be overridden with env var MUTE_HOURS

  // Websites that are allowed (subdomains are allowed automatically)
  ALLOWED_DOMAINS: [
    'wondermayank.in',
    'wondermayank.indevs.in',
    'wondermayank.github.io',
    'thunderstudy.indevs.in',
    'thundertest.indevs.in',
    'thunderstudypdf.indevs.in',
    'commercesehoga.github.io',
  ],

  // Telegram usernames allowed (t.me/<name> and @<name>) — lowercase, no @
  ALLOWED_TG: ['thunderstudy', 'thunderstudycbt', 'thunderstudy_english'],

  // Words / phrases that cause a mute
  BANNED_WORDS: ['dm', 'dms', 'd.m', 'dm me', 'pm me', 'inbox me', 'whatsapp me', 'ping me in dm'],

  COOLDOWN_MS: 20000, // same auto-reply not repeated in a chat within this time
  MAX_AUTOREPLY_LEN: 120, // only auto-reply to short messages (avoids noise)
};

// ───────────────────────── REPLIES ─────────────────────────
const R = {
  cuet:
    '🎯 <b>Free CUET Mock Tests</b>\nFull-length CUET mocks, 100% free — only here:\n👉 https://thundertest.indevs.in/cuet',
  notes:
    '📚 <b>Free Notes</b>\nAll free notes & study material:\n👉 https://thunderstudy.indevs.in',
  english:
    '🗣 <b>English Practice</b>\nPractice reading, grammar & vocab:\n👉 https://english.thunderstudy.indevs.in',
  contact:
    '📩 <b>Contact</b>\nReach the team here:\n👉 https://wondermayank.in/contact',
  ai:
    '🤖 <b>ThunderStudy AI</b>\nAsk doubts & use free AI tools:\n👉 https://ai.thunderstudy.indevs.in',
  mindmap:
    '🧠 <b>AI Mind Map Maker</b>\n👉 https://mindmap.thunderstudy.indevs.in',
  channels:
    '📢 <b>Official Channels</b>\n@thunderstudy · @thunderstudycbt · @thunderstudy_english',
};

const HELP =
  '👋 <b>ThunderStudy Bot</b>\n\n' +
  '/cuet — free CUET mock tests\n' +
  '/notes — free notes\n' +
  '/english — English practice\n' +
  '/ai — AI doubt solver\n' +
  '/contact — contact us\n' +
  '/rules — group rules\n\n' +
  'Or just type <i>cuet</i>, <i>mock</i>, <i>notes</i>, <i>english</i>, <i>contact</i>.';

const RULES =
  '📜 <b>Group Rules</b>\n' +
  '1. No promotion — no links or Telegram channels/groups (except official ThunderStudy ones).\n' +
  '2. No "DM me" / "PM me" requests.\n' +
  '3. Be respectful. Help each other.\n' +
  '4. Breaking rule 1 or 2 = automatic mute.';

const COMMANDS = {
  start: HELP, help: HELP, rules: RULES,
  cuet: R.cuet, mock: R.cuet,
  notes: R.notes,
  english: R.english,
  contact: R.contact,
  ai: R.ai,
  mindmap: R.mindmap,
  channels: R.channels,
};

// keyword triggers (matched on whole words, case-insensitive)
const TRIGGERS = [
  { key: 'cuet', re: /\b(cuet|mocks?|mock tests?|test series|cbt)\b/i },
  { key: 'notes', re: /\b(notes?|study material|pdfs?|syllabus|pyqs?)\b/i },
  { key: 'english', re: /\b(english|grammar|vocab|vocabulary|speaking|reading comprehension|rc)\b/i },
  { key: 'contact', re: /\b(contact|admin|owner|support|creator|developer)\b/i },
  { key: 'ai', re: /\b(ai|tiny|doubts?|chatbot)\b/i },
  { key: 'mindmap', re: /\bmind ?maps?\b/i },
  { key: 'channels', re: /\b(channels?|official channel)\b/i },
];

// ───────────────────────── HELPERS ─────────────────────────
const cooldown = new Map(); // best-effort, per isolate

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BAD_RE = new RegExp(
  '(^|[^a-z0-9])(' +
    CONFIG.BANNED_WORDS.map((w) => reEsc(w).replace(/ /g, '\\s+')).join('|') +
    ')(?=$|[^a-z0-9])',
  'i'
);

// http(s)://…, www.…, t.me/…, tg://…, bare domain.tld/…
const URL_RE =
  /(?:https?:\/\/|tg:\/\/|www\.)[^\s]+|\b(?:t\.me|telegram\.me|telegram\.dog)\/[^\s]+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|in|me|io|org|net|xyz|co|link|app|ly|gl|tk|ml|cc|site|online|shop|store|info|live|club|top|dev|page|run|gg|ai|bio|click|fun|vip)\b(?:\/[^\s]*)?/gi;

const TG_HOSTS = ['t.me', 'telegram.me', 'telegram.dog'];

async function tg(env, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

async function isAdmin(env, chatId, userId) {
  const r = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  return r.ok && ['creator', 'administrator'].includes(r.result.status);
}

function isAllowedUrl(raw) {
  const cleaned = raw.trim().replace(/[)\].,;!?'"]+$/, '');
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(cleaned) ? cleaned : 'https://' + cleaned);
  } catch {
    return true; // unparseable → don't punish
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false; // tg://, mailto:, etc.
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (TG_HOSTS.includes(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    let name = (parts[0] || '').toLowerCase();
    if (name === 's') name = (parts[1] || '').toLowerCase(); // t.me/s/<channel>
    return CONFIG.ALLOWED_TG.includes(name);
  }
  return CONFIG.ALLOWED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

// returns a reason string if the message should be punished, else null
async function findViolation(env, text, entities) {
  const norm = text.normalize('NFKC');

  if (BAD_RE.test(norm)) return 'DM / promotion request';

  const urls = new Set();
  const mentions = new Set();
  for (const e of entities || []) {
    if (e.type === 'url') urls.add(text.substr(e.offset, e.length));
    else if (e.type === 'text_link' && e.url) urls.add(e.url);
    else if (e.type === 'mention') mentions.add(text.substr(e.offset + 1, e.length - 1));
  }
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > 0 && text[m.index - 1] === '@') continue; // email / mention
    urls.add(m[0]);
  }

  for (const u of urls) {
    if (!isAllowedUrl(u)) return 'unauthorised link';
  }

  let lookups = 0;
  for (const name of mentions) {
    const n = name.toLowerCase();
    if (CONFIG.ALLOWED_TG.includes(n)) continue;
    if (n.endsWith('bot')) return 'bot promotion';
    if (lookups++ >= 3) break;
    const r = await tg(env, 'getChat', { chat_id: '@' + name });
    if (r.ok && r.result && r.result.type !== 'private') return 'Telegram channel/group promotion';
  }
  return null;
}

const NO_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
  can_pin_messages: false, can_manage_topics: false,
};

async function punish(env, msg, reason) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const hours = Number(env.MUTE_HOURS) || CONFIG.MUTE_HOURS;

  await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
  const r = await tg(env, 'restrictChatMember', {
    chat_id: chatId,
    user_id: user.id,
    permissions: NO_PERMS,
    use_independent_chat_permissions: true,
    until_date: Math.floor(Date.now() / 1000) + hours * 3600,
  });
  if (!r.ok) return; // e.g. target is admin / bot lacks rights

  const name = esc(user.first_name || 'User');
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text:
      `🔇 <a href="tg://user?id=${user.id}">${name}</a> muted for ${hours}h — ${esc(reason)}.\n` +
      `Links, promotions and "DM" requests aren't allowed here. Read /rules.`,
  });
}

async function reply(env, msg, text) {
  return tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: msg.message_id,
    allow_sending_without_reply: true,
    link_preview_options: { is_disabled: true },
  });
}

// ───────────────────────── UPDATE HANDLER ─────────────────────────
async function handleUpdate(env, update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const isEdit = !!update.edited_message;
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);

  // welcome new members
  if (msg.new_chat_members && !isEdit) {
    const names = msg.new_chat_members
      .filter((m) => !m.is_bot)
      .map((m) => `<a href="tg://user?id=${m.id}">${esc(m.first_name || 'Friend')}</a>`);
    if (names.length) {
      await tg(env, 'sendMessage', {
        chat_id: msg.chat.id,
        parse_mode: 'HTML',
        text:
          `👋 Welcome ${names.join(', ')} to <b>ThunderStudy</b>!\n\n` +
          `🎯 Free CUET mocks: thundertest.indevs.in/cuet\n` +
          `📚 Free notes: thunderstudy.indevs.in\n` +
          `🗣 English practice: english.thunderstudy.indevs.in\n\n` +
          `Please read /rules — no links or DM requests.`,
        link_preview_options: { is_disabled: true },
      });
    }
    return;
  }

  const text = msg.text || msg.caption;
  if (!text || !msg.from || msg.from.is_bot) return;
  if (msg.sender_chat) return; // anonymous admin / linked channel posts
  const entities = msg.entities || msg.caption_entities || [];

  // 1) moderation (groups only)
  if (isGroup) {
    const reason = await findViolation(env, text, entities);
    if (reason && !(await isAdmin(env, msg.chat.id, msg.from.id))) {
      await punish(env, msg, reason);
      return;
    }
  }
  if (isEdit) return;

  // 2) commands
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    if (COMMANDS[cmd]) await reply(env, msg, COMMANDS[cmd]);
    return;
  }

  // 3) keyword auto-replies
  if (text.length > CONFIG.MAX_AUTOREPLY_LEN) return;
  const now = Date.now();
  const out = [];
  for (const t of TRIGGERS) {
    if (!t.re.test(text)) continue;
    const k = msg.chat.id + ':' + t.key;
    if (now - (cooldown.get(k) || 0) < CONFIG.COOLDOWN_MS) continue;
    cooldown.set(k, now);
    out.push(R[t.key]);
    if (out.length === 3) break;
  }
  if (cooldown.size > 500) cooldown.clear();
  if (out.length) await reply(env, msg, out.join('\n\n'));
}

// ───────────────────────── ENTRY ─────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      ctx.waitUntil(handleUpdate(env, update));
      return new Response('ok');
    }
    return new Response('ThunderStudy Bot is running ⚡');
  },
};
