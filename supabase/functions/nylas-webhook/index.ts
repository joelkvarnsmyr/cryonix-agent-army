import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') as string;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
const NYLAS_WEBHOOK_SECRET = Deno.env.get('NYLAS_WEBHOOK_SECRET') as string | undefined;

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!NYLAS_WEBHOOK_SECRET || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(NYLAS_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sigBytes = new Uint8Array(signature.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || []);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  return valid;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (!NYLAS_WEBHOOK_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Missing NYLAS_WEBHOOK_SECRET. Please add it in Supabase Edge Function secrets.' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const raw = await req.text();
    const signature = req.headers.get('X-Nylas-Signature');

    const ok = await verifySignature(raw, signature);
    if (!ok) {
      console.warn('Invalid Nylas webhook signature');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const payload = JSON.parse(raw);
    const grantId = req.headers.get('X-Nylas-Grant-Id') || payload?.data?.grant_id || payload?.grant_id || null;
    if (!grantId) {
      return new Response(JSON.stringify({ error: 'Missing grant id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Find user_id for this grant
    const { data: state } = await admin
      .from('email_sync_state')
      .select('user_id')
      .eq('provider', 'nylas')
      .eq('grant_id', grantId)
      .maybeSingle();

    if (!state?.user_id) {
      console.warn('No sync state found for grant:', grantId);
      return new Response(JSON.stringify({ success: true, message: 'No user mapped for grant' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // If message event, attempt to upsert a minimal row quickly
    const eventType = payload?.type || payload?.event || '';
    const msg = payload?.data || payload?.message || null;

    if (eventType.includes('message') && msg?.id) {
      const mapped = {
        id: msg.id,
        user_id: state.user_id,
        provider: 'nylas',
        grant_id: grantId,
        thread_id: msg.thread_id || null,
        subject: msg.subject || '(ingen ämnesrad)',
        sender: Array.isArray(msg.from) && msg.from.length ? (msg.from[0].email || msg.from[0].name || '') : (msg.from || ''),
        recipients: Array.isArray(msg.to) ? msg.to : (msg.to ? [msg.to] : []),
        snippet: msg.snippet || msg.preview || '',
        body_preview: msg.snippet || msg.preview || '',
        message_date: msg.date ? new Date(msg.date).toISOString() : (msg.received_at ? new Date(msg.received_at).toISOString() : new Date().toISOString()),
        is_read: msg.unread === false,
        raw: msg,
      };
      const { error: upsertErr } = await admin.from('email_messages').upsert([mapped], { onConflict: 'id,user_id' });
      if (upsertErr) console.error('Webhook upsert error:', upsertErr);

      await admin
        .from('email_sync_state')
        .update({ last_synced_at: new Date().toISOString(), total_synced: undefined })
        .eq('user_id', state.user_id)
        .eq('provider', 'nylas');
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error: any) {
    console.error('Error in nylas-webhook function:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
});
