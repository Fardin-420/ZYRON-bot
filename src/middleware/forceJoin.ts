import { GrammyError, InlineKeyboard, type MiddlewareFn } from 'grammy';
import type { AppCtx } from './user.js';
import { logger } from '../logger.js';
import {
  clearForceJoinPending,
  getChannelUrl,
  getForceJoinEnabled,
} from '../services/settings.js';
import { inlineBtn, inlineUrl } from '../keyboards/helpers.js';

const DEFAULT_FORCE_JOIN_CHANNEL = '@NoBoDy_Frdn';
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

async function showForceJoinPrompt(ctx: AppCtx, channelUrl: string): Promise<void> {
  const kb = new InlineKeyboard();
  inlineUrl(kb, ctx.lang, 'force_join', forceJoinUrl(channelUrl)).row();
  inlineBtn(kb, ctx.lang, 'force_join_done', 'forcejoin:done');
  const text = [
    `<tg-emoji emoji-id="${BELL_EMOJI_ID}">🔔</tg-emoji> <b>Please join our Channel to continue using this bot.</b>`,
    '',
    `After joining, tap <b>"Done <tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji>"</b> below.`,
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

export async function checkForceJoinStatus(ctx: AppCtx): Promise<ForceJoinStatus> {
  if (!getForceJoinEnabled()) return 'disabled';
  if (ctx.session.forceJoinUnlocked) return 'joined';
  const channelUrl = getChannelUrl() ?? DEFAULT_FORCE_JOIN_CHANNEL;
  const status = await checkChannelMembership(ctx, channelUrl);
  if (status === 'joined') {
    ctx.session.forceJoinUnlocked = true;
    ctx.session.forceJoinRequired = false;
    await clearForceJoinPending(ctx.user.telegram_id);
  }
  return status;
}

export async function isForceJoinSatisfied(ctx: AppCtx): Promise<boolean> {
  const status = await checkForceJoinStatus(ctx);
  return status === 'disabled' || status === 'joined' || status === 'misconfigured';
}

export async function sendForceJoinPrompt(ctx: AppCtx): Promise<void> {
  const channelUrl = getChannelUrl() ?? DEFAULT_FORCE_JOIN_CHANNEL;
  await showForceJoinPrompt(ctx, channelUrl);
}

export const forceJoinMiddleware: MiddlewareFn<AppCtx> = async (ctx, next) => {
  if (!ctx.from) return next();
  if (!getForceJoinEnabled()) return next();
  if (ctx.callbackQuery?.data === 'forcejoin:done') return next();
  if (ctx.from.id === Number(process.env.ADMIN_USER_ID || 0)) return next();

  // Every user is checked on every update (the result is cached in the session
  // once they are confirmed as a member, so this costs one API call per session).
  const status = await checkForceJoinStatus(ctx);
  if (status === 'disabled' || status === 'joined' || status === 'misconfigured') return next();
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: 'Please join the channel first, then tap Done.',
      show_alert: true,
    });
  }
  try {
    await sendForceJoinPrompt(ctx);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.debug({ telegram_id: ctx.from.id }, 'force-join prompt skipped for blocked user');
      return;
    }
    throw err;
  }
};
