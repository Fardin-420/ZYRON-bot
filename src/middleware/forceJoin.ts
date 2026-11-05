import { GrammyError, InlineKeyboard, type MiddlewareFn } from 'grammy';
import type { AppCtx } from './user.js';
import { logger } from '../logger.js';
import {
  clearForceJoinPending,
  getForceJoinChannels,
  getForceJoinEnabled,
} from '../services/settings.js';
import { inlineBtn } from '../keyboards/helpers.js';
import { listAdminTelegramIds } from '../db/queries.js';

const DEFAULT_FORCE_JOIN_CHANNELS = ['@NoBoDy_Frdn', '@npcbackup'];
const BELL_EMOJI_ID = '5798670723975221399';
const DONE_EMOJI_ID = '6170055790146098906';

// 'misconfigured' = the bot itself cannot read the channel member list
// (removed from the channel, lost admin rights, wrong chat id). In that case the
// gate opens so the shop keeps selling, and the problem is logged loudly.
// 'unknown' = a transient Telegram error -> the gate stays closed.
export type ForceJoinStatus =
  | 'disabled'
  | 'joined'
  | 'not_joined'
  | 'unknown'
  | 'misconfigured';

// Telegram error descriptions that mean "this bot cannot check this chat at all".
const MISCONFIG_PATTERNS = [
  'chat not found',
  'bot is not a member',
  'member list is inaccessible',
  'chat_admin_required',
  'not enough rights',
  'bot was kicked',
];

// Telegram errors that mean "this user is simply not in the channel".
const NOT_JOINED_PATTERNS = ['user not found', 'participant_id_invalid'];

function isNotJoinedError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = (err.description || '').toLowerCase();
  return NOT_JOINED_PATTERNS.some((p) => d.includes(p));
}

function isMisconfigError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = (err.description || '').toLowerCase();
  return MISCONFIG_PATTERNS.some((p) => d.includes(p));
}

function forceJoinChatId(channelUrl: string): string | number | null {
  const raw = channelUrl.trim();
  if (/^-100\d+$/.test(raw)) return Number(raw);
  if (/^@[A-Za-z0-9_]{5,}$/i.test(raw)) return raw;
  const m = raw.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{5,})(?:\/.*)?$/i);
  return m ? `@${m[1]}` : null;
}

function forceJoinUrl(channelUrl: string): string {
  const raw = channelUrl.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('@')) return `https://t.me/${raw.slice(1)}`;
  return raw;
}

async function checkChannelMembership(ctx: AppCtx, channelUrl: string): Promise<ForceJoinStatus> {
  const chatId = forceJoinChatId(channelUrl);
  if (!chatId) {
    logger.error({ channelUrl }, 'force-join: invalid channel URL - gate disabled until fixed');
    return 'misconfigured';
  }
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.from!.id);
    return ['left', 'kicked'].includes(member.status) ? 'not_joined' : 'joined';
  } catch (err) {
    if (isNotJoinedError(err)) return 'not_joined';
    if (isMisconfigError(err)) {
      logger.error(
        { err, channelUrl },
        'force-join: bot cannot read channel members - make the bot an admin of the channel. Gate is open until fixed.',
      );
      return 'misconfigured';
    }
    logger.warn({ err, channelUrl }, 'force-join: membership check failed (transient)');
    return 'unknown';
  }
}

/** Channel titles, resolved once per process so the prompt can name them. */
const titleCache = new Map<string, string>();

async function channelTitle(ctx: AppCtx, channelUrl: string): Promise<string> {
  const cached = titleCache.get(channelUrl);
  if (cached) return cached;
  const chatId = forceJoinChatId(channelUrl);
  let title = channelUrl.replace(/^https?:\/\/t\.me\//i, '@');
  if (chatId) {
    try {
      const chat = await ctx.api.getChat(chatId);
      if ('title' in chat && chat.title) title = chat.title;
    } catch {
      // Fall back to the handle; a failed getChat is not worth blocking on.
    }
  }
  titleCache.set(channelUrl, title);
  return title;
}

async function showForceJoinPrompt(ctx: AppCtx, missing: string[]): Promise<void> {
  const channels = missing.length > 0 ? missing : activeForceJoinChannels();
  const kb = new InlineKeyboard();
  for (const channel of channels) {
    const title = await channelTitle(ctx, channel);
    kb.url(`📢 Join ${title}`, forceJoinUrl(channel)).row();
  }
  inlineBtn(kb, ctx.lang, 'force_join_done', 'forcejoin:done');
  const plural = channels.length > 1;
  const text = [
    `<tg-emoji emoji-id="${BELL_EMOJI_ID}">🔔</tg-emoji> <b>Please join ${
      plural ? `all ${channels.length} channels` : 'our Channel'
    } to continue using this bot.</b>`,
    '',
    `After joining ${plural ? 'both' : ''}, tap <b>"Done <tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji>"</b> below.`,
  ].join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.debug({ telegram_id: ctx.from?.id }, 'force-join prompt skipped for blocked user');
      return;
    }
    throw err;
  }
}

// Admin ids from the `admins` table, cached so the gate costs no query per
// update. Refreshed at most once a minute.
let adminIdCache: Set<number> = new Set();
let adminIdCacheAt = 0;
const ADMIN_CACHE_TTL_MS = 60_000;

async function refreshAdminIds(): Promise<void> {
  if (Date.now() - adminIdCacheAt < ADMIN_CACHE_TTL_MS) return;
  adminIdCacheAt = Date.now();
  try {
    adminIdCache = new Set(await listAdminTelegramIds());
  } catch (err) {
    logger.warn({ err }, 'force-join: admin id refresh failed, keeping cached list');
  }
}

/** Admins are never gated: the owner plus every admin row in the database. */
async function isForceJoinExempt(ctx: AppCtx): Promise<boolean> {
  if (!ctx.from) return false;
  if (ctx.from.id === Number(process.env.ADMIN_USER_ID || 0)) return true;
  await refreshAdminIds();
  return adminIdCache.has(ctx.from.id);
}

function activeForceJoinChannels(): string[] {
  const configured = getForceJoinChannels();
  return configured.length > 0 ? configured : DEFAULT_FORCE_JOIN_CHANNELS;
}

/**
 * Check every configured channel. The user is only let through once they are
 * a member of ALL of them. `missing` lists the channels still to join, so the
 * prompt can show one button per channel instead of a generic link.
 */
export async function checkForceJoin(
  ctx: AppCtx,
): Promise<{ status: ForceJoinStatus; missing: string[] }> {
  if (!getForceJoinEnabled()) return { status: 'disabled', missing: [] };
  if (ctx.session.forceJoinUnlocked) return { status: 'joined', missing: [] };

  const channels = activeForceJoinChannels();
  const results = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      status: await checkChannelMembership(ctx, channel),
    })),
  );

  const missing = results.filter((r) => r.status === 'not_joined').map((r) => r.channel);
  // Precedence: a channel the user must still join wins over any error, and a
  // transient error keeps the gate shut while a broken config opens it.
  let status: ForceJoinStatus;
  if (missing.length > 0) status = 'not_joined';
  else if (results.some((r) => r.status === 'unknown')) status = 'unknown';
  else if (results.every((r) => r.status === 'misconfigured')) status = 'misconfigured';
  else status = 'joined';

  if (status === 'joined') {
    ctx.session.forceJoinUnlocked = true;
    ctx.session.forceJoinRequired = false;
    await clearForceJoinPending(ctx.user.telegram_id);
  }
  return { status, missing };
}

export async function checkForceJoinStatus(ctx: AppCtx): Promise<ForceJoinStatus> {
  const { status } = await checkForceJoin(ctx);
  return status;
}

export async function isForceJoinSatisfied(ctx: AppCtx): Promise<boolean> {
  const status = await checkForceJoinStatus(ctx);
  return status === 'disabled' || status === 'joined' || status === 'misconfigured';
}

export async function sendForceJoinPrompt(ctx: AppCtx, missing: string[] = []): Promise<void> {
  await showForceJoinPrompt(ctx, missing);
}

export const forceJoinMiddleware: MiddlewareFn<AppCtx> = async (ctx, next) => {
  if (!ctx.from) return next();
  if (!getForceJoinEnabled()) return next();
  if (ctx.callbackQuery?.data === 'forcejoin:done') return next();
  // Only private chats are gated. In a group (the public feed group, the log
  // group) the bot must never answer with a join prompt.
  if (ctx.chat && ctx.chat.type !== 'private') return next();
  if (await isForceJoinExempt(ctx)) return next();

  // Every user is checked on every update (the result is cached in the session
  // once they are confirmed as a member of every channel, so this costs one
  // round of API calls per session).
  const { status, missing } = await checkForceJoin(ctx);
  if (status === 'disabled' || status === 'joined' || status === 'misconfigured') return next();
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text:
        missing.length > 1
          ? 'Please join both channels first, then tap Done.'
          : 'Please join the channel first, then tap Done.',
      show_alert: true,
    });
  }
  const blockedText = ctx.message?.text ?? '';
  if (/^\/start(?:@\S+)?\s+\S/.test(blockedText)) {
    ctx.session.pendingStartText = blockedText;
  }
  try {
    await sendForceJoinPrompt(ctx, missing);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.debug({ telegram_id: ctx.from.id }, 'force-join prompt skipped for blocked user');
      return;
    }
    throw err;
  }
};
