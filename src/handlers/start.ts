import type { Composer } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { formatPriceWithCurrency } from '../../config/currencies.js';
import type { AppCtx } from '../middleware/user.js';
import { activateReferralForUser } from '../middleware/user.js';
import { mainMenuKeyboard } from '../keyboards/mainMenu.js';
import { renderMdHtml } from '../services/premium.js';
import { getOrder, getProduct } from '../db/queries.js';
import { applyUserPriceToProduct } from '../services/pricing.js';
import { productKeyboard } from '../keyboards/shop.js';
import { QTY_MIN } from '../../config/index.js';
import { env } from '../env.js';
import { parsePublicOrderId, publicOrderId } from '../services/orderId.js';
import { formatReceivedItemsBlock } from '../services/orderRender.js';
import * as adminLog from '../services/adminLog.js';
import { clearAiSession, showSupportMenu } from './support.js';
import {
  disableButtonChrome,
  inlineBtn,
  isButtonChromeEnabled,
  isButtonChromeError,
} from '../keyboards/helpers.js';
import { showProfile, showReferScreen } from './profile.js';
import { showTopupMenu } from './topup.js';
import { showShopHome } from './shop.js';
import { showApiPanel } from './resellerApi.js';
import {
  checkForceJoin,
  sendForceJoinPrompt,
} from '../middleware/forceJoin.js';
import { logger } from '../logger.js';

/**
 * Silently dismiss any leftover persistent reply keyboard from older
 * versions of the bot. We send a near-invisible message with
 * `remove_keyboard: true`, then immediately delete it. The keyboard
 * removal sticks even after the message is gone. Once-per-session.
 */
async function clearOldReplyKeyboard(ctx: AppCtx): Promise<void> {
  if (ctx.session.kbCleared) return;
  ctx.session.kbCleared = true;
  if (!ctx.chat) return;
  try {
    const m = await ctx.api.sendMessage(ctx.chat.id, '\u2063', {
      reply_markup: { remove_keyboard: true },
    });
    try {
      await ctx.api.deleteMessage(ctx.chat.id, m.message_id);
    } catch {
      /* deletion is best-effort */
    }
  } catch {
    /* sending is best-effort */
  }
}

/**
 * Build the welcome screen as HTML, wrapping every configured
 * premium emoji in `<tg-emoji>` tags so premium subscribers see the
 * styled glyph and everyone else sees the unicode fallback.
 */
function buildWelcomeHtml(ctx: AppCtx): string {
  const title = ctx.t('welcome.title');
  const balance = ctx.t('welcome.balance', { balance: Number(ctx.user.balance).toFixed(2) });
  const body = `{welcome_banner} *${title}*\n\n{welcome_balance} ${balance}`;
  return renderMdHtml(body, {
    welcome_banner: 'welcome_banner',
    welcome_balance: 'welcome_balance',
  });
}

export async function showMainMenu(
  ctx: AppCtx,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const html = buildWelcomeHtml(ctx);
  const plainText = [ctx.t('welcome.title'), '', ctx.t('welcome.balance', { balance: Number(ctx.user.balance).toFixed(2) })].join(
    '\n',
  );

  const isChromeFailure = (err: unknown): boolean => {
    if (!isButtonChromeEnabled()) return false;
    if (!isButtonChromeError(err)) return false;
    disableButtonChrome();
    logger.warn({ err }, 'main-menu: disabled button icon/style chrome after Telegram API failure');
    return true;
  };

  const sendPlainFallback = async (): Promise<void> => {
    await ctx.reply(plainText);
  };

  // If we got here via callback (e.g. "⬅️ Main Menu" button) edit in place.
  if (!opts.fresh && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(html, {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(ctx.lang),
      });
      return;
    } catch (err) {
      if (isChromeFailure(err)) {
        try {
          await ctx.editMessageText(html, {
            parse_mode: 'HTML',
            reply_markup: mainMenuKeyboard(ctx.lang),
          });
          return;
        } catch {
          // fallback to send below
        }
      }
      // editing failed (e.g. message too old or Telegram rejected HTML) → fall through to send
    }
  }

  try {
    await ctx.reply(html, {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(ctx.lang),
    });
    return;
  } catch (err) {
    if (isChromeFailure(err)) {
      try {
        await ctx.reply(html, {
          parse_mode: 'HTML',
          reply_markup: mainMenuKeyboard(ctx.lang),
        });
        return;
      } catch {
        // Continue to the no-formatting fallback below.
      }
    }
    logger.error({ err }, 'main-menu: formatted response failed; sending plain fallback');
    await sendPlainFallback();
  }
}

/**
 * The `/start <payload>` text to act on. When the force-join gate blocked the
 * original message, the middleware stashed it in the session so the deep link
 * still resolves once the user has joined and tapped Done.
 */
function startText(ctx: AppCtx): string {
  return ctx.message?.text ?? ctx.session.pendingStartText ?? '';
}

/** Run the deep-link chain; returns true when one of them handled the update. */
async function runStartDeepLinks(ctx: AppCtx): Promise<boolean> {
  if (await handleReferDeepLink(ctx)) return true;
  if (await handleSettingsDeepLink(ctx)) return true;
  if (await handleTopupDeepLink(ctx)) return true;
  if (await handleApiDeepLink(ctx)) return true;
  if (await handleShopDeepLink(ctx)) return true;
  if (await handleSupportDeepLink(ctx)) return true;
  if (await handleProductDeepLink(ctx)) return true;
  if (await handleInvoiceDeepLink(ctx)) return true;
  return false;
}

async function maybeGateForceJoin(ctx: AppCtx): Promise<boolean> {
  // Checked for every user, not only for the ones flagged as pending: an
  // existing user who leaves the channel is gated again on their next action.
  const { status, missing } = await checkForceJoin(ctx);
  if (status === 'disabled' || status === 'joined' || status === 'misconfigured') return false;
  await sendForceJoinPrompt(ctx, missing);
  return true;
}

/**
 * Inspect the /start payload for a `prod_<id>` deep link emitted by
 * the Copy/Share button on the product page. When present, render
 * the product page directly so the friend who tapped the share link
 * lands exactly where the sharer wanted them. Returns true when the
 * deep link was handled and the caller should NOT show the main menu.
 */
async function handleProductDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  const m = text.match(/^\/start(?:@\S+)?\s+prod_(\d+)/i);
  if (!m) return false;
  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) return false;
  const raw = await getProduct(id);
  if (!raw) return false;
  const p = await applyUserPriceToProduct(ctx.user.telegram_id, raw);
  const qty = ctx.session.qty[p.id] ?? QTY_MIN;
  const total = formatPriceWithCurrency(p.price * qty, ctx.user.currency);
  const productEmoji = p.emoji === '🛒' ? '' : (p.emoji ?? '');
  const body = [
    ctx.t('shop.product.line.name', { name: p.name, emoji: productEmoji }),
    ctx.t('shop.product.line.price', { price: formatPriceWithCurrency(p.price, ctx.user.currency) }),
    ctx.t('shop.product.line.stock', { stock: p.stock }),
    ctx.t('shop.product.line.warranty', { warranty: p.warranty ?? '—' }),
    ctx.t('shop.product.line.qty', { qty }),
    ctx.t('shop.product.line.total', { total }),
    ctx.t('shop.product.line.balance', { balance: formatPriceWithCurrency(ctx.user.balance, ctx.user.currency) }),
  ]
    .filter(Boolean)
    .join('\n');
  // Plain deep-link URL — fed straight into the keyboard's
  // `copy_text` button so a tap copies it to the user's clipboard
  // (no share-to-chat dialog, no automatic forward — see PR #57).
  const shareUrl = `https://t.me/${env.BOT_USERNAME}?start=prod_${p.id}`;
  await ctx.reply(renderMdHtml(body), {
    parse_mode: 'HTML',
    reply_markup: productKeyboard(ctx.lang, p, qty, shareUrl),
  });
  return true;
}

/**
 * Handle `/start ord_<publicId>` deep links — these are emitted by
 * the post-purchase invoice email "Re-open in Telegram" button and
 * by the in-chat "View Invoice" buttons under the Order Delivered
 * card. We resolve the public id back to a DB row, double-check
 * ownership, and render a compact order summary so the buyer lands
 * directly on their invoice instead of bouncing through Settings →
 * My Orders → Find by ID.
 */
async function handleInvoiceDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  const m = text.match(/^\/start(?:@\S+)?\s+ord_([0-9A-Z]+)/i);
  if (!m) return false;
  const dbId = parsePublicOrderId(`ORD${m[1]}`);
  if (!dbId) return false;
  const order = await getOrder(dbId);
  if (!order || order.user_id !== ctx.user.telegram_id) return false;
  const pubId = publicOrderId(order);
  const status =
    order.status === 'paid'
      ? ctx.t('orders.status.active')
      : order.status === 'refunded'
        ? ctx.t('orders.status.refunded')
        : ctx.t('orders.status.cancelled');
  const total = Number(order.total).toFixed(order.total % 1 === 0 ? 0 : 2);
  const lines = [
    ctx.t('orders.detail.title'),
    '',
    ctx.t('orders.detail.id', { id: pubId }),
    ctx.t('orders.detail.product', { name: order.product_name }),
    ctx.t('orders.detail.qty', { qty: order.qty }),
    ctx.t('orders.detail.total', { total }),
    ctx.t('orders.detail.status', { status }),
  ];
  // Prefer the per-item delivered pool so each link renders as its
  // own quoted pill; fall back to the legacy single-line delivery
  // text for older orders that pre-date `delivered_items`.
  const itemsBlock = formatReceivedItemsBlock(order.delivered_items);
  if (itemsBlock) {
    lines.push('', ctx.t('orders.detail.received', { received: itemsBlock }));
  } else if (order.delivery) {
    const urlMatch = order.delivery.match(/https?:\/\/\S+/);
    const deliveryText = urlMatch ? urlMatch[0] : order.delivery;
    lines.push('', ctx.t('orders.detail.received', { received: deliveryText }));
  }
  const kb = new InlineKeyboard();
  inlineBtn(kb, ctx.lang, 'back', 'main:open');
  await ctx.reply(renderMdHtml(lines.join('\n')), {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  return true;
}

async function handleReferDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+refer\b/i.test(text)) return false;
  await showReferScreen(ctx, { forceReply: true });
  return true;
}

async function handleSettingsDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+settings\b/i.test(text)) return false;
  await showProfile(ctx, { forceReply: true });
  return true;
}

async function handleTopupDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+topup\b/i.test(text)) return false;
  await showTopupMenu(ctx, false);
  return true;
}

async function handleApiDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+api\b/i.test(text)) return false;
  await showApiPanel(ctx);
  return true;
}

async function handleShopDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+shop\b/i.test(text)) return false;
  await showShopHome(ctx);
  return true;
}

async function handleSupportDeepLink(ctx: AppCtx): Promise<boolean> {
  const text = startText(ctx);
  if (!/^\/start(?:@\S+)?\s+support\b/i.test(text)) return false;
  await showSupportMenu(ctx);
  return true;
}

export function registerStart(bot: Composer<AppCtx>): void {
  bot.command('start', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    // Reset AI Support state so a stale session doesn't intercept
    // later text messages after the user navigates away from it.
    clearAiSession(ctx.from?.id);
    // First-start admin log — fires only on the very first /start so
    // the admin sees a clean "new user joined" entry. The sentinel
    // is set by getOrCreateUser when the row was just inserted.
    const flagged = ctx.user as typeof ctx.user & { __just_created?: boolean };
    if (flagged.__just_created) {
      void adminLog.logFirstStart(ctx.api, {
        user: {
          telegram_id: ctx.user.telegram_id,
          username: ctx.user.username ?? null,
          first_name: ctx.user.first_name ?? null,
          email: ctx.user.email ?? null,
        },
        referralCode: ctx.user.ref_code ?? null,
        referredBy: ctx.user.referred_by ?? null,
      });
    }
    if (await maybeGateForceJoin(ctx)) return;
    if (flagged.__just_created) {
      await activateReferralForUser(ctx);
    }
    if (await runStartDeepLinks(ctx)) return;
    await showMainMenu(ctx, { fresh: true });
  });

  bot.command('menu', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showMainMenu(ctx, { fresh: true });
  });

  bot.command('products', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showShopHome(ctx);
  });

  bot.command('deposit', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showTopupMenu(ctx, false);
  });

  bot.command('settings', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showProfile(ctx, { forceReply: true });
  });

  bot.command('support', async (ctx) => {
    await clearOldReplyKeyboard(ctx);
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showSupportMenu(ctx);
  });

  // "⬅️ Main Menu" inline button used across screens.
  bot.callbackQuery('main:open', async (ctx) => {
    await ctx.answerCallbackQuery();
    // Reset any in-flight user flow when returning to the main menu so
    // a stale prompt (e.g. set_email) can't capture later messages.
    ctx.session.userFlow = undefined;
    clearAiSession(ctx.from?.id);
    if (await maybeGateForceJoin(ctx)) return;
    await showMainMenu(ctx);
  });

  bot.callbackQuery('forcejoin:done', async (ctx) => {
    const { status, missing } = await checkForceJoin(ctx);
    // Fail closed: only a confirmed membership (or a disabled / broken-config
    // gate) unlocks the bot. A transient check failure keeps the gate shut.
    if (status === 'joined') {
      ctx.session.forceJoinUnlocked = true;
      await activateReferralForUser(ctx);
      await ctx.answerCallbackQuery({ text: 'Access unlocked.' });
      // Replay the deep link the gate blocked (shared product, invoice,
      // top-up, support) so the user lands where the link pointed. The
      // payload stays in the session while the chain runs, since that is
      // where the handlers read it from, and is cleared either way.
      const pending = ctx.session.pendingStartText;
      let handled = false;
      if (pending) {
        try {
          handled = await runStartDeepLinks(ctx);
        } finally {
          ctx.session.pendingStartText = undefined;
        }
      }
      if (handled) return;
      await showMainMenu(ctx);
      return;
    }
    if (status === 'disabled' || status === 'misconfigured') {
      ctx.session.forceJoinUnlocked = true;
      await ctx.answerCallbackQuery();
      await showMainMenu(ctx);
      return;
    }
    if (status === 'not_joined') {
      await ctx.answerCallbackQuery({
        text:
          missing.length > 1
            ? 'Please join both channels first, then tap Done.'
            : 'Please join the channel first, then tap Done.',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({
      text: 'Could not verify your membership. Please try again in a moment.',
      show_alert: true,
    });
  });

  // Legacy channel button callback: send the user back through the gate.
  bot.callbackQuery('channel:open', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (await maybeGateForceJoin(ctx)) return;
    await showMainMenu(ctx);
  });
}
