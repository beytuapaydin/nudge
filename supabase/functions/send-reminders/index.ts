import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createSignedActionUrl, escapeHtml, getLocalClock } from '../_shared/utils.ts';

const STEPS = [7, 3, 1, 0];

function diffDaysISO(deadlineISO: string, localTodayISO: string): number {
  const target = Date.parse(`${deadlineISO}T00:00:00Z`);
  const today = Date.parse(`${localTodayISO}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

function buildSubject(
  daysLeft: number,
  title: string,
  amount: number | null,
  currency: string | null
): string {
  const prefix = daysLeft === 0 ? 'Today' : daysLeft === 1 ? 'Tomorrow' : `In ${daysLeft} days`;
  const price = amount !== null ? `, ${amount} ${currency || 'EUR'}` : '';
  return `${prefix}: ${title}${price}`;
}

function buildEmailHtml(params: {
  title: string;
  nextAction: string;
  deadline: string;
  amount: number | null;
  currency: string | null;
  doneUrl: string;
  snoozeUrl: string;
}): string {
  const safeTitle = escapeHtml(params.title);
  const safeNextAction = escapeHtml(params.nextAction);
  const safeDeadline = escapeHtml(params.deadline);
  const safeCurrency = escapeHtml(params.currency || 'EUR');

  const costLine =
    params.amount !== null
      ? `<p style="margin:6px 0;color:#44403c;">Amount: <strong>${escapeHtml(params.amount)} ${safeCurrency}</strong></p>`
      : '';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FAF8F5;padding:24px;color:#292524;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #E6DFD5;border-radius:20px;padding:24px;">
      <p style="margin:0 0 8px;font-size:12px;color:#2F6F62;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Gentle Nudge</p>
      <h2 style="margin:0 0 10px;font-size:20px;color:#1c1917;">${safeTitle}</h2>
      <p style="margin:6px 0;color:#44403c;">Deadline: <strong>${safeDeadline}</strong></p>
      ${costLine}
      <p style="margin:14px 0 22px;line-height:1.5;color:#44403c;">${safeNextAction}</p>
      <div>
        <a href="${escapeHtml(params.doneUrl)}" style="display:inline-block;background:#2F6F62;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600;margin-right:10px;">Done</a>
        <a href="${escapeHtml(params.snoozeUrl)}" style="display:inline-block;background:#F3EFE9;color:#292524;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;border:1px solid #E6DFD5;">Snooze 1 day</a>
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#78716c;">This is a summary, not legal advice. Check the original.</p>
    </div>
  </div>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resend allows only a few requests per second: pace the sends and retry once on 429.
async function sendMail(url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  if (res.status === 429) {
    await sleep(1500);
    res = await fetch(url, init);
  }
  await sleep(600);
  return res;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret) {
    return new Response(JSON.stringify({ error: 'CRON_SECRET is not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let force = false;
  try {
    const body = await req.json();
    force = body?.force === true;
  } catch {
    // Empty body from pg_cron
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const signingSecret = Deno.env.get('ACTION_SIGNING_SECRET');
  const resendFrom = Deno.env.get('RESEND_FROM_EMAIL') || 'Nudge <onboarding@resend.dev>';
  const actionBaseUrl =
    Deno.env.get('ACTION_PAGE_URL') || `${supabaseUrl}/functions/v1/handle-reminder-action`;

  if (!resendKey || !signingSecret) {
    return new Response(
      JSON.stringify({ error: 'Missing RESEND_API_KEY or ACTION_SIGNING_SECRET.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // PostgREST returns at most 1000 rows per request, so read in pages.
  const profiles: Array<{ user_id: string; timezone: string | null }> = [];
  let profErr: { message: string } | null = null;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('user_id, timezone')
      .order('user_id')
      .range(from, from + 999);
    if (error) { profErr = error; break; }
    profiles.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  // deno-lint-ignore no-explicit-any
  const items: any[] = [];
  let itemErr: { message: string } | null = null;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('nudge_items')
      .select('*')
      .eq('status', 'active')
      .not('deadline', 'is', null)
      .order('id')
      .range(from, from + 999);
    if (error) { itemErr = error; break; }
    items.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  if (profErr || itemErr) {
    return new Response(
      JSON.stringify({ error: profErr?.message || itemErr?.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const tzByUser = new Map<string, string>();
  for (const p of profiles || []) {
    tzByUser.set(p.user_id, p.timezone || 'UTC');
  }

  // Resolve verified auth emails per user_id once per run
  const emailByUser = new Map<string, string | null>();
  async function getRecipientEmail(userId: string): Promise<string | null> {
    if (emailByUser.has(userId)) {
      return emailByUser.get(userId) ?? null;
    }
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) {
      console.error(`getUserById failed for ${userId}:`, error.message);
      emailByUser.set(userId, null);
      return null;
    }
    const verifiedEmail = data?.user?.email || null;
    emailByUser.set(userId, verifiedEmail);
    return verifiedEmail;
  }

  const now = new Date();
  let emailsSent = 0;
  let movedToWaiting = 0;
  let skippedTimezone = 0;

  for (const item of items || []) {
    const userTz = tzByUser.get(item.user_id) || 'UTC';
    const { localDateISO, localHour } = getLocalClock(userTz, now);

    if (!force && localHour !== 8) {
      skippedTimezone++;
      continue;
    }

    const daysLeft = diffDaysISO(item.deadline, localDateISO);

    if (daysLeft < 0) {
      await supabase
        .from('nudge_items')
        .update({ status: 'waiting_room', updated_at: now.toISOString() })
        .eq('id', item.id);
      movedToWaiting++;
      continue;
    }

    if (item.snoozed_until && localDateISO < item.snoozed_until) {
      continue;
    }

    const sentSteps: number[] = item.sent_steps || [];
    const dueSteps = STEPS.filter((s) => daysLeft <= s && !sentSteps.includes(s));
    if (dueSteps.length === 0) continue;

    const isDayBeforeOrDayOf = daysLeft === 0 || daysLeft === 1;
    if (!isDayBeforeOrDayOf && (item.unresponded_count || 0) >= 2) {
      await supabase
        .from('nudge_items')
        .update({ status: 'waiting_room', updated_at: now.toISOString() })
        .eq('id', item.id);
      movedToWaiting++;
      continue;
    }

    const recipientEmail = await getRecipientEmail(item.user_id);
    if (!recipientEmail) {
      continue;
    }

    const doneUrl = await createSignedActionUrl(actionBaseUrl, signingSecret, item.id, 'done');
    const snoozeUrl = await createSignedActionUrl(actionBaseUrl, signingSecret, item.id, 'snooze');

    const subject = buildSubject(daysLeft, item.title, item.amount, item.currency);
    const html = buildEmailHtml({
      title: item.title,
      nextAction: item.next_action,
      deadline: item.deadline,
      amount: item.amount,
      currency: item.currency,
      doneUrl,
      snoozeUrl,
    });

    const mailRes = await sendMail('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [recipientEmail],
        subject,
        html,
      }),
    });

    if (mailRes.ok) {
      const updatedSent = Array.from(new Set([...sentSteps, ...dueSteps]));
      await supabase
        .from('nudge_items')
        .update({
          sent_steps: updatedSent,
          unresponded_count: (item.unresponded_count || 0) + 1,
          updated_at: now.toISOString(),
        })
        .eq('id', item.id);
      emailsSent++;
    } else {
      console.error(`Resend error for item ${item.id}:`, await mailRes.text());
    }
  }

  return new Response(
    JSON.stringify({ ok: true, force, emailsSent, movedToWaiting, skippedTimezone }),
    { headers: { 'Content-Type': 'application/json' } }
  );
});
