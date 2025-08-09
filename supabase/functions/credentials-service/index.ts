import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AES-GCM helpers
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function getCryptoKey() {
  const secret = Deno.env.get("MASTER_ENCRYPTION_KEY");
  if (!secret) throw new Error("MASTER_ENCRYPTION_KEY is not set");
  // Treat secret as raw utf-8 key material
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(plaintext: string) {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plaintext),
  );
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  const ivB64 = btoa(String.fromCharCode(...iv));
  return { encrypted: cipherB64, iv: ivB64 };
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
    const { data: userRes } = await supabase.auth.getUser();
    let userId: string | undefined = userRes?.user?.id;
    if (!userId && authHeader) {
      try {
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        userId = payload.sub as string | undefined;
      } catch {}
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const { action, payload } = await req.json();

    if (action === "save") {
      const { service, username, email, host, port, secret, config } = payload as {
        service: "imap" | "smtp" | "caldav" | "nylas";
        username: string;
        email?: string;
        host?: string;
        port?: number;
        secret: string;
        config?: Record<string, unknown>;
      };

      if (!service || !username || !secret) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      const { encrypted, iv } = await encrypt(secret);

      const { data, error } = await supabase
        .from("service_credentials")
        .insert({
          user_id: userId,
          service,
          username,
          email: email ?? null,
          host: host ?? null,
          port: port ?? null,
          config: config ?? {},
          encrypted_secret: encrypted,
          iv,
        })
        .select("id").single();

      if (error) throw error;
      return new Response(JSON.stringify({ success: true, id: data.id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (action === "list") {
      const { data, error } = await supabase
        .from("service_credentials")
        .select("id, service, username, email, host, port, config, created_at, updated_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, credentials: data }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (e: any) {
    console.error("credentials-service error", e);
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
});