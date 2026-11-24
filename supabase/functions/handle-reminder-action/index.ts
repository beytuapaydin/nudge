import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { escapeHtml, getLocalClock, verifySignedAction } from '../_shared/utils.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function renderPage(title: string, bodyHtml: string, status = 200): Response {
  return new Response(
    `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Nudge — ${escapeHtml(title)}</title>
      </head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FAF8F5;color:#292524;padding:32px 16px;">
        <div style="max-width:440px;margin:40px auto;background:#fff;border:1px solid #E6DFD5;border-radius:24px;padding:28px;text-align:center;">
          ${bodyHtml}
        </div>
      </body>
    </html>`,
    { status, headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function addOneDayISO(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const signingSecret = Deno.env.get('ACTION_SIGNING_SECRET');
  if (!signingSecret) {
    return jsonResponse({ error: 'Missing signing configuration.' }, 500);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const wantsJson = (req.headers.get('Accept') || '').includes('application/json');

  // Read-only GET confirmation
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') || '';
    const action = url.searchParams.get('action') || '';
    const exp = url.searchParams.get('exp') || '';
    const sig = url.searchParams.get('sig') || '';

    const valid = await verifySignedAction(signingSecret, id, action, exp, sig);
    if (!valid) {
      if (wantsJson) return jsonResponse({ error: 'Link expired or invalid.' }, 400);
      return renderPage(
        'Link expired',
        '<h1 style="margin:0 0 10px;font-size:22px;color:#2F6F62;">Link expired or invalid</h1><p style="margin:0;color:#57534e;">Open Nudge in your browser to update this item.</p>',
        400
      );
    }

    const { data: item } = await supabase
      .from('nudge_items')
      .select('title, next_action, status')
      .eq('id', id)
      .maybeSingle();

    if (!item) {
      if (wantsJson) return jsonResponse({ error: 'Item not found.' }, 404);
      return renderPage(
        'Not found',
        '<h1 style="margin:0 0 10px;font-size:22px;color:#2F6F62;">Item not found</h1>',
        404
      );
    }

    if (wantsJson) {
      return jsonResponse({
        ok: true,
        title: item.title,
        next_action: item.next_action,
        status: item.status,
      });
    }

    const safeTitle = escapeHtml(item.title);
    const safeNextAction = escapeHtml(item.next_action);
    const buttonLabel = action === 'done' ? 'Confirm: Mark done' : 'Confirm: Snooze 1 day';
    const postUrl = `${supabaseUrl}/functions/v1/handle-reminder-action`;

    return renderPage(
      'Confirm action',
      `<p style="margin:0 0 8px;font-size:12px;color:#2F6F62;font-weight:600;text-transform:uppercase;">Nudge</p>
       <h1 style="margin:0 0 10px;font-size:22px;color:#1c1917;">${safeTitle}</h1>
       <p style="margin:0 0 22px;line-height:1.5;color:#57534e;">${safeNextAction}</p>
       <form method="POST" action="${escapeHtml(postUrl)}">
         <input type="hidden" name="id" value="${escapeHtml(id)}" />
         <input type="hidden" name="action" value="${escapeHtml(action)}" />
         <input type="hidden" name="exp" value="${escapeHtml(exp)}" />
         <input type="hidden" name="sig" value="${escapeHtml(sig)}" />
         <button type="submit" style="width:100%;min-height:48px;border:0;border-radius:14px;background:#2F6F62;color:#fff;font-size:16px;font-weight:600;cursor:pointer;padding:12px 20px;">
           ${escapeHtml(buttonLabel)}
         </button>
       </form>`
    );
  }

  // Mutating POST action
  if (req.method === 'POST') {
    const contentType = req.headers.get('Content-Type') || '';
    let id = '';
    let action = '';
    let exp = '';
    let sig = '';

    if (contentType.includes('application/json')) {
      const body = await req.json();
      id = String(body.id || '');
      action = String(body.action || '');
      exp = String(body.exp || '');
      sig = String(body.sig || '');
    } else {
      const form = await req.formData();
      id = String(form.get('id') || '');
      action = String(form.get('action') || '');
      exp = String(form.get('exp') || '');
      sig = String(form.get('sig') || '');
    }

    const valid = await verifySignedAction(signingSecret, id, action, exp, sig);
    if (!valid) {
      if (wantsJson || contentType.includes('application/json')) {
        return jsonResponse({ error: 'Link expired or invalid.' }, 400);
      }
      return renderPage(
        'Link expired',
        '<h1 style="margin:0 0 10px;font-size:22px;color:#2F6F62;">Link expired or invalid</h1>',
        400
      );
    }

    const { data: item } = await supabase
      .from('nudge_items')
      .select('id, user_id, title')
      .eq('id', id)
      .maybeSingle();

    if (!item) {
      if (wantsJson || contentType.includes('application/json')) {
        return jsonResponse({ error: 'Item not found.' }, 404);
      }
      return renderPage('Not found', '<h1>Item not found</h1>', 404);
    }

    const safeTitle = escapeHtml(item.title);
    const nowISO = new Date().toISOString();

    if (action === 'done') {
      await supabase
        .from('nudge_items')
        .update({ status: 'done', updated_at: nowISO })
        .eq('id', id);

      if (wantsJson || contentType.includes('application/json')) {
        return jsonResponse({ ok: true, action: 'done', title: item.title });
      }
      return renderPage(
        'Done',
        `<h1 style="margin:0 0 10px;font-size:22px;color:#2F6F62;">Marked done</h1>
         <p style="margin:0;line-height:1.5;color:#57534e;"><strong>${safeTitle}</strong> is handled. You can close this tab.</p>`
      );
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('timezone')
      .eq('user_id', item.user_id)
      .maybeSingle();

    const { localDateISO } = getLocalClock(profile?.timezone || 'UTC');
    const tomorrowISO = addOneDayISO(localDateISO);

    await supabase
      .from('nudge_items')
      .update({ snoozed_until: tomorrowISO, unresponded_count: 0, updated_at: nowISO })
      .eq('id', id);

    if (wantsJson || contentType.includes('application/json')) {
      return jsonResponse({
        ok: true,
        action: 'snooze',
        title: item.title,
        snoozed_until: tomorrowISO,
      });
    }
    return renderPage(
      'Snoozed',
      `<h1 style="margin:0 0 10px;font-size:22px;color:#2F6F62;">Snoozed for 1 day</h1>
       <p style="margin:0;line-height:1.5;color:#57534e;"><strong>${safeTitle}</strong> will wait until ${escapeHtml(tomorrowISO)}. You can close this tab.</p>`
    );
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
});
