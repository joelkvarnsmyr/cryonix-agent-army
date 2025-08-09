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
      const { baseUrl, username, password } = body as { baseUrl: string; username: string; password: string };
      if (!baseUrl || !username || !password) return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

      const normBase = ((): string => {
        const b = baseUrl.trim();
        if (!/^https?:\/\//i.test(b)) return `https://${b}`;
        return b;
      })();

      const auth = basicAuthHeader(username, password);
      const headersBase: HeadersInit = { Authorization: auth, "Content-Type": "application/xml; charset=utf-8" };

      async function propfind(url: string, depth: "0" | "1" = "0", bodyXml: string) {
        const h = new Headers(headersBase);
        h.set("Depth", depth);
        const resp = await fetch(url, { method: "PROPFIND", headers: h, body: bodyXml });
        const text = await resp.text();
        return { resp, text };
      }

      // Step 1: discover current-user-principal
      const principalBody = xml`
        <?xml version="1.0" encoding="utf-8"?>
        <d:propfind xmlns:d="DAV:">
          <d:prop>
            <d:current-user-principal/>
          </d:prop>
        </d:propfind>
      `;
      const { resp: principalResp, text: principalXml } = await propfind(normBase, "0", principalBody);
      if (!principalResp.ok && principalResp.status !== 207) {
        // Try well-known fallback
        const fallback = normBase.replace(/\/$/, "") + "/.well-known/caldav";
        const alt = await propfind(fallback, "0", principalBody);
        if (!alt.resp.ok && alt.resp.status !== 207) {
          return new Response(JSON.stringify({ error: `CalDAV discovery failed ${alt.resp.status}`, details: alt.text }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
        // Use alt
        const hrefMatch = alt.text.match(/<\w*:href>([^<]+)<\/\w*:href>/i);
        const principalUrl = hrefMatch ? new URL(hrefMatch[1], fallback).toString() : fallback;

        // Step 2: get calendar-home-set
        const homeBody = xml`
          <?xml version="1.0" encoding="utf-8"?>
          <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
            <d:prop>
              <cal:calendar-home-set/>
            </d:prop>
          </d:propfind>
        `;
        const home = await propfind(principalUrl, "0", homeBody);
        if (!home.resp.ok && home.resp.status !== 207) {
          return new Response(JSON.stringify({ error: `CalDAV home failed ${home.resp.status}`, details: home.text }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
        const homeHref = home.text.match(/<cal:calendar-home-set[^>]*>\s*<\w*:href>([^<]+)<\/\w*:href>/i)?.[1]
          || home.text.match(/<\w*:href>([^<]+)<\/\w*:href>/i)?.[1];
        const homeUrl = homeHref ? new URL(homeHref, principalUrl).toString() : principalUrl;

        // Step 3: list calendars (depth 1)
        const listBody = xml`
          <?xml version="1.0" encoding="UTF-8"?>
          <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
            <d:prop>
              <d:displayname />
              <cal:supported-calendar-component-set />
            </d:prop>
          </d:propfind>
        `;
        const list = await propfind(homeUrl, "1", listBody);
        if (!list.resp.ok && list.resp.status !== 207) {
          return new Response(JSON.stringify({ error: `CalDAV list failed ${list.resp.status}`, details: list.text }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
        return new Response(JSON.stringify({ success: true, principalUrl, homeUrl, xml: list.text }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // Principal OK
      const principalHref = principalXml.match(/<\w*:href>([^<]+)<\/\w*:href>/i)?.[1];
      const principalUrl = principalHref ? new URL(principalHref, normBase).toString() : normBase;

      // Step 2
      const homeBody = xml`
        <?xml version="1.0" encoding="utf-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <cal:calendar-home-set/>
          </d:prop>
        </d:propfind>
      `;
      const { resp: homeResp, text: homeXml } = await propfind(principalUrl, "0", homeBody);
      if (!homeResp.ok && homeResp.status !== 207) {
        return new Response(JSON.stringify({ error: `CalDAV home failed ${homeResp.status}`, details: homeXml }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }
      const homeHref = homeXml.match(/<cal:calendar-home-set[^>]*>\s*<\w*:href>([^<]+)<\/\w*:href>/i)?.[1]
        || homeXml.match(/<\w*:href>([^<]+)<\/\w*:href>/i)?.[1];
      const homeUrl = homeHref ? new URL(homeHref, principalUrl).toString() : principalUrl;

      // Step 3: list calendars
      const listBody = xml`
        <?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:displayname />
            <cal:supported-calendar-component-set />
          </d:prop>
        </d:propfind>
      `;
      const { resp: listResp, text: listXml } = await propfind(homeUrl, "1", listBody);
      if (!listResp.ok && listResp.status !== 207) {
        return new Response(JSON.stringify({ error: `CalDAV list failed ${listResp.status}`, details: listXml }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      return new Response(JSON.stringify({ success: true, principalUrl, homeUrl, xml: listXml }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
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