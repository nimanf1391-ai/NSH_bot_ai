const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = Number(process.env.MAX_REQUESTS_PER_MINUTE || 8);
const requestCounts = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const old = requestCounts.get(key);
  if (!old || now - old.start >= WINDOW_MS) requestCounts.set(key, { start: now, count: 1 });
  else if (old.count >= MAX_REQUESTS_PER_WINDOW) return res.status(429).json({ error: 'درخواست‌ها زیاد شده؛ یک دقیقه بعد دوباره امتحان کن.' });
  else old.count++;
  next();
}

async function optionalWebSearch(query) {
  if (!process.env.TAVILY_API_KEY) return '';
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 4, include_answer: false })
  });
  if (!r.ok) return '';
  const data = await r.json();
  return (data.results || []).map((x, i) => `${i + 1}. ${x.title}\n${x.content}\nمنبع: ${x.url}`).join('\n\n');
}

app.post('/api/chat', rateLimit, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'اتصال هوش مصنوعی هنوز تنظیم نشده است.' });
  const message = String(req.body?.message || '').trim().slice(0, 4000);
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8).map(x => String(x).slice(0, 1500)) : [];
  if (!message) return res.status(400).json({ error: 'پیام خالی است.' });

  try {
    let webContext = '';
    const needsSearch = /(جست.?وجو|در اینترنت|اخبار|امروز|جدیدترین|آخرین|قیمت|امسال|چه خبر|منبع)/i.test(message);
    if (needsSearch && process.env.TAVILY_API_KEY) {
      webContext = await optionalWebSearch(message);
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const system = `تو NSH.bot هستی؛ دستیار آموزشی فارسی برای ریاضی و علوم. پاسخ‌ها را روشن، دقیق و متناسب با دانش‌آموز بنویس. مسائل ریاضی را مرحله‌به‌مرحله حل کن و اگر مطمئن نیستی صادقانه بگو. برای اطلاعات روز از متن جست‌وجوی ارائه‌شده استفاده کن و منبع و نشانی آن را ذکر کن. اگر جست‌وجو انجام نشده، وانمود نکن که اینترنت را بررسی کرده‌ای. از درخواست اطلاعات شخصی، رمز یا کلیدهای محرمانه خودداری کن.`;
    const messages = [
      { role: 'system', content: system },
      ...history.map(content => ({ role: 'user', content })),
      { role: 'user', content: message + (webContext ? `\n\nنتایج جست‌وجوی وب (برای استناد و خلاصه‌سازی):\n${webContext}` : '') }
    ];
    const completion = await client.chat.completions.create({ model: MODEL, messages, max_tokens: 700, temperature: 0.4 });
    const reply = completion.choices?.[0]?.message?.content?.trim() || 'پاسخی دریافت نشد.';
    res.json({ reply, searched: Boolean(webContext) });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: 'فعلاً پاسخ‌گویی هوشمند انجام نشد. تنظیمات سرور را بررسی کن.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'NSH.bot' }));
app.listen(PORT, () => console.log(`NSH.bot server running on port ${PORT}`));
