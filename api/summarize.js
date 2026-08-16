// 文字起こしテキストの要約プロキシ: Claude (Anthropic Messages API) を使用
// 減災教育講演向けの要約フォーマットで出力する

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY_NOT_CONFIGURED' });

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    return res.status(400).json({ error: 'INVALID_JSON_BODY' });
  }

  const { text } = body;
  if (!text) return res.status(400).json({ error: 'MISSING_TEXT' });

  const systemPrompt = `あなたは防災教育講演の要約担当です。以下は講演の文字起こしです。日本語で要約してください。

出力フォーマット（厳守）:
■ 概要（3行以内）
■ 主要トピック（箇条書き、5〜8項目）
■ 質疑応答・参加者の反応（あれば箇条書き、なければ「特になし」）
■ フォローアップ事項（あれば箇条書き、なければ「特になし」）

文字起こしに含まれる言い淀み・ノイズ・重複は無視し、内容の骨子のみ抽出してください。前置きや締めの挨拶文は不要です。`;

  try {
    // Claudeは大きなコンテキストウィンドウを持つのでGroqのLlamaのような
    // TPM(1分あたりトークン数)制限に引っかかりにくい。長時間講演でもそのまま送る。
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          { role: 'user', content: text.slice(0, 400000) },
        ],
      }),
    });

    const data = await claudeRes.json();
    if (!claudeRes.ok) {
      return res.status(claudeRes.status).json({ error: data.error?.message || 'CLAUDE_ERROR' });
    }

    const summary = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(502).json({ error: 'PROXY_ERROR', detail: e.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
