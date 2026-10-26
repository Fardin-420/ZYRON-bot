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
const SKIP_EMOJI_ID = '5843822645711212265';

export type ForceJoinStatus = 'disabled' | 'joined' | 'not_joined' | 'unknown';

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
    logger.warn({ channelUrl }, 'force-join: invalid channel URL');
    return 'unknown';
  }
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.from!.id);
    return ['left', 'kicked'].includes(member.status) ? 'not_joined' : 'joined';
  } catch (err) {
    logger.warn({ err, channelUrl }, 'force-join: membership check failed');
    return 'unknown';
  }
}

async function showForceJoinPrompt(ctx: AppCtx, channelUrl: string): Promise<void> {
  const kb = new InlineKeyboard();
  inlineUrl(kb, ctx.lang, 'force_join', forceJoinUrl(channelUrl)).row();
  inlineBtn(kb, ctx.lang, 'force_join_done', 'forcejoin:done').row();
  inlineBtn(kb, ctx.lang, 'force_join_skip', 'forcejoin:skip');
  const text = [
    `<tg-emoji emoji-id="${BELL_EMOJI_ID}">🔔</tg-emoji> <b>Please join our Channel to continue using this bot.</b>`,
    '',
    `After joining, tap <b>"Done <tg-emoji emoji-id="${DONE_EMOJI_ID}">✅</tg-emoji>"</b> below.`,
    '',
    `Or tap <b>"Skip <tg-emoji emoji-id="${SKIP_EMOJI_ID}">🔕</tg-emoji>"</b> to continue without joining.`,
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
  return status === 'disabled' || status === 'joined';
}

export async function sendForceJoinPrompt(ctx: AppCtx): Promise<void> {
  const channelUrl = getChannelUrl() ?? DEFAULT_FORCE_JOIN_CHANNEL;
  await showForceJoinPrompt(ctx, channelUrl);
}

export const forceJoinMiddleware: MiddlewareFn<AppCtx> = async (ctx, next) => {
  if (!ctx.from) return next();
  if (!getForceJoinEnabled()) return next();
  if (ctx.callbackQuery?.data === 'forcejoin:done') return next();
  if (ctx.callbackQuery?.data === 'forcejoin:skip') return next();
  if (ctx.from.id === Number(process.env.ADMIN_USER_ID || 0)) return next();
  if (
    !(ctx.session.forceJoinRequired ||
      (ctx.user as typeof ctx.user & { __just_created?: boolean }).__just_created)
  ) {
    return next();
  }

  const status = await checkForceJoinStatus(ctx);
  if (status === 'disabled' || status === 'joined') return next();
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
