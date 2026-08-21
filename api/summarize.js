// 文字起こしテキストの要約プロキシ: Groq LLM (openai/gpt-oss-120b) を使用
// 減災教育講演向けの要約フォーマットで出力する
//
// 長文対策: TPM(1分あたりトークン数)上限に引っかかる長さの場合、
// テキストをチャンクに分割 → 各チャンクを個別要約 → 最後にまとめて統合要約する
// 2段階方式にする。

const TPM_SAFE_CHARS = 30000; // 1リクエストの本文をこの文字数以下に抑える(日本語想定の安全マージン)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY_NOT_CONFIGURED' });

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

  const finalSystemPrompt = `あなたは防災教育講演の要約担当です。以下は講演の文字起こしです。日本語で要約してください。

出力フォーマット（厳守）:
■ 概要（3行以内）
■ 主要トピック（箇条書き、5〜8項目）
■ 質疑応答・参加者の反応（あれば箇条書き、なければ「特になし」）
■ フォローアップ事項（あれば箇条書き、なければ「特になし」）

文字起こしに含まれる言い淀み・ノイズ・重複は無視し、内容の骨子のみ抽出してください。前置きや締めの挨拶文は不要です。`;

  const partialSystemPrompt = `あなたは講演文字起こしの要約担当です。以下は長い講演の一部分の文字起こしです。
この部分に含まれる主要な発言・トピックを日本語で簡潔に箇条書きにしてください。
前置きや締めの挨拶は不要です。この部分の内容だけを抽出してください。`;

  async function callGroq(systemPrompt, userContent, maxTokens) {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
    });
    const data = await groqRes.json();
    if (!groqRes.ok) {
      const err = new Error(data.error?.message || 'GROQ_ERROR');
      err.status = groqRes.status;
      throw err;
    }
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  try {
    let summary;

    if (text.length <= TPM_SAFE_CHARS) {
      // 短い場合はそのまま1回で要約
      summary = await callGroq(finalSystemPrompt, text, 2048);
    } else {
      // 長い場合: チャンクに分割 → 各チャンクを個別要約 → 統合要約
      const partialSummaries = [];
      for (let i = 0; i < text.length; i += TPM_SAFE_CHARS) {
        const chunk = text.slice(i, i + TPM_SAFE_CHARS);
        const partial = await callGroq(partialSystemPrompt, chunk, 1024);
        partialSummaries.push(partial);
      }
      const combined = partialSummaries
        .map((p, idx) => `【区間${idx + 1}】\n${p}`)
        .join('\n\n');
      summary = await callGroq(finalSystemPrompt, combined, 2048);
    }

    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || 'PROXY_ERROR' });
  }
};

module.exports.config = { api: { bodyParser: false } };
