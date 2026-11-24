import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const DAILY_LIMIT = 30;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_TEXT_CHARS = 20_000;

function getBase64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

// Keep this text identical to sysPrompt() in web/nudge.html and nudge-eval.html,
// so the accuracy you measure in the test page is the accuracy you get in production.
function buildSystemPrompt(today: string): string {
  return [
    'You extract key deadline and cost facts from screenshots, emails, bills, letters, or short user notes.',
    `Today's local date is ${today}.`,
    'Input may be in any language. Write title and next_action in clear, calm English.',
    '1. If the deadline is missing, ambiguous or unreliable, set deadline to null and confidence to "low". Never guess a date.',
    '2. If the amount is unclear or not applicable, set amount and currency to null.',
    '3. next_action is one short, helpful sentence. No legal advice, no panic.',
    '4. Return only JSON matching the schema.',
  ].join('\n');
}

// The browser sends its local date; accept it only if it is within one day of the server date.
function pickToday(clientDate: unknown, serverDate: string): string {
  if (typeof clientDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(clientDate)) return serverDate;
  const diff = Math.abs(Date.parse(`${clientDate}T00:00:00Z`) - Date.parse(`${serverDate}T00:00:00Z`));
  return diff <= 86_400_000 ? clientDate : serverDate;
}

// Gemini sometimes answers 429/500/503 ("high demand"). Retry a few times with a short wait.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let res = await fetch(url, init);
  for (let i = 1; i < attempts && [429, 500, 503].includes(res.status); i++) {
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 1500 * 2 ** (i - 1)));
    res = await fetch(url, init);
  }
  return res;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonError('Authentication required.', 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiKey = Deno.env.get('GEMINI_API_KEY');

    if (!geminiKey) {
      console.error('extract-nudge error: GEMINI_API_KEY is not configured.');
      return jsonError('Service temporarily unavailable.', 500);
    }

    // 1. Verify JWT
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return jsonError('Invalid or expired session.', 401);
    }

    // 2. Parse JSON strictly (400 on invalid JSON)
    let body: { text?: unknown; imageBase64?: unknown; mimeType?: unknown; date?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonError('Invalid JSON request body.', 400);
    }

    const { text, imageBase64, mimeType, date } = body ?? {};
    if (!text && !imageBase64) {
      return jsonError('Provide text or imageBase64.', 400);
    }

    if (text !== undefined && text !== null) {
      if (typeof text !== 'string') {
        return jsonError('text must be a string.', 400);
      }
      if (text.length > MAX_TEXT_CHARS) {
        return jsonError(`Text exceeds ${MAX_TEXT_CHARS} character limit.`, 413);
      }
    }

    if (imageBase64 !== undefined && imageBase64 !== null) {
      if (typeof imageBase64 !== 'string') {
        return jsonError('imageBase64 must be a string.', 400);
      }
      if (getBase64ByteLength(imageBase64) > MAX_IMAGE_BYTES) {
        return jsonError('Image exceeds 4 MB limit.', 413);
      }
    }

    // 3. Pre-check current daily usage
    const adminClient = createClient(supabaseUrl, serviceKey);
    const todayUTC = new Date().toISOString().slice(0, 10);

    const { data: usageRow, error: usageErr } = await adminClient
      .from('extract_usage')
      .select('request_count')
      .eq('user_id', user.id)
      .eq('usage_date', todayUTC)
      .maybeSingle();

    if (usageErr) {
      console.error('extract-nudge usage read error:', usageErr);
      return jsonError('Could not extract details right now.', 500);
    }

    if ((usageRow?.request_count ?? 0) >= DAILY_LIMIT) {
      return jsonError(`Daily limit of ${DAILY_LIMIT} extractions reached.`, 429);
    }

    // 4. Call Gemini with x-goog-api-key header
    const parts = imageBase64
      ? [
          {
            inlineData: {
              mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg',
              data: imageBase64 as string,
            },
          },
          { text: 'Extract the deadline, cost, and one next action from this image.' },
        ]
      : [{ text: text as string }];

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const res = await fetchWithRetry(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: buildSystemPrompt(pickToday(date, todayUTC)) }],
        },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              type: {
                type: 'STRING',
                enum: ['subscription_trial', 'return_window', 'bill', 'official_letter', 'other'],
              },
              amount: { type: 'NUMBER', nullable: true },
              currency: { type: 'STRING', nullable: true },
              deadline: { type: 'STRING', nullable: true },
              next_action: { type: 'STRING' },
              confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
              language: { type: 'STRING' },
            },
            required: [
              'title',
              'type',
              'amount',
              'currency',
              'deadline',
              'next_action',
              'confidence',
              'language',
            ],
          },
        },
      }),
    });

    if (!res.ok) {
      console.error(`Gemini API error (${res.status}):`, await res.text());
      return jsonError('Could not extract details right now.', 500);
    }

    const data = await res.json();
    const rawJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawJson) {
      console.error('Gemini returned an empty response:', JSON.stringify(data));
      return jsonError('Could not extract details right now.', 500);
    }

    // Ensure valid JSON before charging quota
    JSON.parse(rawJson);

    // 5. Consume quota only after a successful Gemini response
    const { data: allowed, error: quotaError } = await adminClient.rpc(
      'consume_extract_quota',
      { p_user_id: user.id, p_limit: DAILY_LIMIT }
    );

    if (quotaError) {
      console.error('consume_extract_quota error:', quotaError);
      return jsonError('Could not extract details right now.', 500);
    }
    if (!allowed) {
      return jsonError(`Daily limit of ${DAILY_LIMIT} extractions reached.`, 429);
    }

    return new Response(rawJson, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('extract-nudge unhandled error:', err);
    return jsonError('Could not extract details right now.', 500);
  }
});
