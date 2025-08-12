import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface IngestRequest {
  grantId: string;
  limit?: number;       // items per page (Nylas supports up to ~200)
  maxPages?: number;    // number of pages to fetch this run
  pageToken?: string;   // continue from token
}

const NYLAS_BASE = Deno.env.get('NYLAS_API_BASE') || 'https://api.us.nylas.com';
const NYLAS_CLIENT_ID = Deno.env.get('NYLAS_CLIENT_ID') as string;
const NYLAS_API_KEY = Deno.env.get('NYLAS_API_KEY') as string;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') as string;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') as string;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;

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

    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = (await req.json()) as IngestRequest;
    const { grantId, limit = 200, maxPages = 5, pageToken } = body;

    if (!NYLAS_CLIENT_ID || !NYLAS_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'Missing NYLAS_CLIENT_ID or NYLAS_API_KEY secret' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!grantId) {
      return new Response(
        JSON.stringify({ error: 'Missing grantId' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const { data: auth } = await supabase.auth.getUser();
    const user = auth?.user;
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Load existing sync state
    const { data: stateRow } = await admin
      .from('email_sync_state')
      .select('*')
      .eq('user_id', user.id)
      .eq('provider', 'nylas')
      .maybeSingle();

    // Mark as running
    const { data: upsertState, error: upsertErr } = await admin
      .from('email_sync_state')
      .upsert({
        user_id: user.id,
        provider: 'nylas',
        grant_id: grantId,
        status: 'running',
        cursor: pageToken ?? stateRow?.cursor ?? null,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' })
      .select('*')
      .single();

    if (upsertErr) {
      console.error('Failed to update sync state:', upsertErr);
    }

    let nextToken: string | null = upsertState?.cursor ?? null;
    let processed = 0;
    let page = 0;

    while (page < maxPages) {
      const url = new URL(`${NYLAS_BASE}/v3/messages`);
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 200)));
      if (nextToken) url.searchParams.set('page_token', nextToken);

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${NYLAS_API_KEY}`,
          'X-Nylas-Client-Id': NYLAS_CLIENT_ID,
          'X-Nylas-Grant-Id': grantId,
          'Content-Type': 'application/json',
        },
      });
      const json = await resp.json();

      if (!resp.ok) {
        console.error('Nylas ingest error:', json);
        await admin
          .from('email_sync_state')
          .update({ status: 'error', error: json?.message || 'Nylas error', last_synced_at: new Date().toISOString() })
          .eq('user_id', user.id)
          .eq('provider', 'nylas');
        return new Response(
          JSON.stringify({ error: json?.message || 'Failed to list messages via Nylas' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const items: any[] = (json?.data || json?.messages || []);

      // Map and upsert
      const mapped = items.map((m: any) => ({
        id: m.id,
        user_id: user.id,
        provider: 'nylas',
        grant_id: grantId,
        thread_id: m.thread_id || null,
        subject: m.subject || '(ingen ämnesrad)',
        sender: Array.isArray(m.from) && m.from.length ? (m.from[0].email || m.from[0].name || '') : (m.from || ''),
        recipients: Array.isArray(m.to) ? m.to : (m.to ? [m.to] : []),
        snippet: m.snippet || m.preview || '',
        body_preview: m.snippet || m.preview || '',
        message_date: m.date ? new Date(m.date).toISOString() : (m.received_at ? new Date(m.received_at).toISOString() : new Date().toISOString()),
        is_read: m.unread === false,
        raw: m,
      }));

      if (mapped.length) {
        const { error: upsertMsgErr } = await admin
          .from('email_messages')
          .upsert(mapped, { onConflict: 'id,user_id' });
        if (upsertMsgErr) {
          console.error('Upsert messages error:', upsertMsgErr);
        }
        processed += mapped.length;
      }

      nextToken = json?.next_cursor || json?.next_page_token || json?.nextPageToken || null;
      page += 1;
      if (!nextToken) break;
    }

    const newTotal = (stateRow?.total_synced ?? 0) + processed;

    await admin
      .from('email_sync_state')
      .update({
        status: nextToken ? 'idle' : 'idle',
        cursor: nextToken,
        total_synced: newTotal,
        last_synced_at: new Date().toISOString(),
        error: null,
      })
      .eq('user_id', user.id)
      .eq('provider', 'nylas');

    return new Response(
      JSON.stringify({ success: true, processed, nextCursor: nextToken, pages: page }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (error: any) {
    console.error('Error in nylas-ingest function:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
});
