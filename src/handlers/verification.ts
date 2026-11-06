import { InlineKeyboard, type Composer } from 'grammy';
import type { AppCtx } from '../middleware/user.js';

// Preview-only: no billing, identity submission, or provider automation.
const keyboard = () => new InlineKeyboard()
  .text('Guide', 'verify:guide').text('Task History', 'verify:history').row()
  .text('Referral Credits', 'verify:credits').text('Deposit Wallet', 'topup:open').row()
  .text('Back', 'main:open');

export function registerVerification(bot: Composer<AppCtx>): void {
  bot.command('verify', async ctx => {
    if (ctx.chat?.type !== 'private') return;
    await ctx.reply('Student Verification\n\nPreview only. No payments or submissions are enabled. Only genuine students using their own information may request verification.', { reply_markup: keyboard() });
  });
  bot.callbackQuery('verify:guide', async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Guide\n\nUse your own authentic student information and follow the official eligibility instructions. Requests are disabled in this preview.', { reply_markup: keyboard() });
  });
  bot.callbackQuery('verify:history', async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Task History\n\nTracking will be available after a secure, user-scoped database is configured.', { reply_markup: keyboard() });
  });
  bot.callbackQuery('verify:credits', async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Referral Credits\n\nPlanned: 1 free credit per 5 qualified referrals; maximum 10 qualified referrals daily. Credits are not active yet.', { reply_markup: keyboard() });
  });
}
