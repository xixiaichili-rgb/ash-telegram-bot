const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

// 初始化
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 读取 system prompt
const systemPrompt = fs.existsSync(path.join(__dirname, 'CLAUDE.md'))
  ? fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf-8')
  : 'You are a helpful assistant.';

// 对话历史（内存存储，重启会清空）
const conversations = new Map();
const MAX_HISTORY = 40; // 保留最近20轮对话

// 只允许你自己用（填你的 Telegram user ID）
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim()))
  : [];

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  // 如果设置了白名单，检查权限
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    return ctx.reply('没有权限。');
  }

  const userMessage = ctx.message.text;

  // /clear 清空对话历史
  if (userMessage === '/clear') {
    conversations.delete(userId);
    return ctx.reply('对话已清空。');
  }

  // /id 查看自己的 user ID
  if (userMessage === '/id') {
    return ctx.reply(`你的 Telegram User ID: ${userId}`);
  }

  // 获取或创建对话历史
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });

  // 超出长度裁剪
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  try {
    // 发送 typing 状态
    await ctx.sendChatAction('typing');

    const response = await anthropic.messages.create({
      model: process.env.MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text;
    history.push({ role: 'assistant', content: reply });

    // Telegram 消息长度限制 4096，超长分段发
    if (reply.length <= 4096) {
      await ctx.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,4096}/g);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    }
  } catch (error) {
    console.error('API Error:', error.message);
    await ctx.reply('出了点问题，稍后再试。');
  }
});

bot.launch();
console.log('Bot started.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
