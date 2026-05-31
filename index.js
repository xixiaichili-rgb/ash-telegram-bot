const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const path = require('path');

// 初始化
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 存储每个用户的 Claude Code session ID
const sessions = new Map();

// CLAUDE.md 路径
const systemPromptFile = path.join(__dirname, 'CLAUDE.md');

// 只允许你自己用
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => parseInt(id.trim()))
  : [];

function isAllowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

// 调用 Claude Code CLI
function callClaude(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',                              // 非交互模式
      '--output-format', 'json',         // JSON 输出，方便解析 session_id
      '--dangerously-skip-permissions',  // 跳过权限确认（bot 没法手动确认）
      '--system-prompt-file', systemPromptFile,
      '--model', 'claude-opus-4-6',
    ];

    // 如果有 session ID，恢复之前的对话
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // 用户消息作为参数
    args.push(message);

    const proc = spawn('claude', args, {
      timeout: 180000,  // 3分钟超时
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('Claude CLI stderr:', stderr);
        // 如果 resume 失败，可能是 session 过期了，返回特殊错误
        if (sessionId && (stderr.includes('session') || stderr.includes('resume'))) {
          reject(new Error('SESSION_EXPIRED'));
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr}`));
        }
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          text: result.result || result.text || '',
          sessionId: result.session_id || null,
        });
      } catch {
        // JSON 解析失败，用原始输出
        resolve({ text: stdout.trim(), sessionId: null });
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// 持续发送 typing 状态
function keepTyping(ctx) {
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// /start 命令
bot.command('start', (ctx) => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('没有权限。');
  return ctx.reply('我在。');
});

// /clear 清空对话（删除 session ID，下次会开新对话）
bot.command('clear', (ctx) => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('没有权限。');
  sessions.delete(ctx.from.id);
  return ctx.reply('对话已清空，下条消息会开始新对话。');
});

// /id 查看自己的 user ID
bot.command('id', (ctx) => {
  return ctx.reply(`你的 Telegram User ID: ${ctx.from.id}`);
});

// /session 查看当前 session 信息
bot.command('session', (ctx) => {
  if (!isAllowed(ctx.from.id)) return ctx.reply('没有权限。');
  const sid = sessions.get(ctx.from.id);
  return ctx.reply(sid ? `当前 Session: ${sid}` : '没有活跃的对话。');
});

// 处理文字消息
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAllowed(userId)) return ctx.reply('没有权限。');

  const userMessage = ctx.message.text;
  const stopTyping = keepTyping(ctx);

  try {
    let sessionId = sessions.get(userId) || null;
    let response;

    try {
      response = await callClaude(userMessage, sessionId);
    } catch (err) {
      // 如果 session 过期了，重新开一个新对话
      if (err.message === 'SESSION_EXPIRED') {
        console.log(`Session expired for user ${userId}, starting new session`);
        sessions.delete(userId);
        response = await callClaude(userMessage, null);
      } else {
        throw err;
      }
    }

    // 保存 session ID
    if (response.sessionId) {
      sessions.set(userId, response.sessionId);
    }

    const reply = response.text;
    if (!reply) {
      await ctx.reply('（没有收到回复，再试一次）');
      return;
    }

    // Telegram 消息长度限制 4096
    if (reply.length <= 4096) {
      await ctx.reply(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,4096}/g);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    await ctx.reply('出了点问题，稍后再试。');
  } finally {
    stopTyping();
  }
});

bot.launch();
console.log('Bot started.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
