import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const xml = (strings: TemplateStringsArray, ...values: any[]) =>
  strings.reduce((acc, s, i) => acc + s + (values[i] ?? ""), "");

function basicAuthHeader(user: string, pass: string) {
  const token = btoa(`${user}:${pass}`);
  return `Basic ${token}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: auth } = await supabase.auth.getUser();
    let userId: string | undefined = auth?.user?.id;
    if (!userId && authHeader) {
      try {
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        userId = payload.sub as string | undefined;
      } catch {}
    }
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const body = await req.json();
    const { action } = body as { action: string };

    if (action === "caldav-list-calendars") {
      // Requires: baseUrl, username, password OR Authorization header (one.com supports basic)
      const { baseUrl, username, password } = body as { baseUrl: string; username: string; password: string };
      if (!baseUrl || !username || !password) return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

      const headers: HeadersInit = {
        Authorization: basicAuthHeader(username, password),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      };

      const propfind = xml`
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:displayname />
            <cal:supported-calendar-component-set />
          </d:prop>
        </d:propfind>
      `;

      const resp = await fetch(baseUrl, { method: "PROPFIND", headers, body: propfind });
      const text = await resp.text();
      if (!resp.ok) return new Response(JSON.stringify({ error: `CalDAV error ${resp.status}`, details: text }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

      // Simple parse: return raw XML (UI can parse); production would parse properly
      return new Response(JSON.stringify({ success: true, xml: text }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (action === "caldav-events") {
      // Requires: calendarUrl, username, password, from, to (ISO)
      const { calendarUrl, username, password, from, to } = body as { calendarUrl: string; username: string; password: string; from: string; to: string };
      if (!calendarUrl || !username || !password || !from || !to) return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

      const headers: HeadersInit = {
        Authorization: basicAuthHeader(username, password),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      };

      const report = xml`
        <?xml version="1.0" encoding="utf-8" ?>
        <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:getetag/>
            <c:calendar-data/>
          </d:prop>
          <c:filter>
            <c:comp-filter name="VCALENDAR">
              <c:comp-filter name="VEVENT">
                <c:time-range start="${from.replace(/[-:]/g, '').split('.')[0]}Z" end="${to.replace(/[-:]/g, '').split('.')[0]}Z"/>
              </c:comp-filter>
            </c:comp-filter>
          </c:filter>
        </c:calendar-query>
      `;

      const resp = await fetch(calendarUrl, { method: "REPORT", headers, body: report });
      const text = await resp.text();
      if (!resp.ok) return new Response(JSON.stringify({ error: `CalDAV error ${resp.status}`, details: text }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

      return new Response(JSON.stringify({ success: true, xml: text }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (e: any) {
    console.error("caldav-service error", e);
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});