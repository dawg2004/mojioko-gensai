// テキスト翻訳プロキシ: Groq LLM (llama) を使用
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY_NOT_CONFIGURED' });

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const { text, targetLang } = body;

  if (!text) return res.status(400).json({ error: 'MISSING_TEXT' });

  const lang = targetLang || 'ja';
  const langName = lang === 'ja' ? '日本語' : lang;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate the following text into ${langName}. Output ONLY the translated text, no explanations, no notes.`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      return res.status(groqRes.status).json({ error: data.error?.message || 'GROQ_ERROR' });
    }

    const translated = data.choices?.[0]?.message?.content?.trim() || '';
    return res.json({ translated });
  } catch (e) {
    return res.status(502).json({ error: 'PROXY_ERROR', detail: e.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
