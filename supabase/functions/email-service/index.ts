import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface EmailConfig {
  provider: 'gmail' | 'outlook' | 'onecom' | 'imap';
  email: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  isRead: boolean;
}

const PROVIDER_CONFIGS = {
  gmail: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
  },
  outlook: {
    imapHost: 'imap-mail.outlook.com',
    imapPort: 993,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
  },
  onecom: {
    imapHost: 'imap.one.com',
    imapPort: 993,
    smtpHost: 'smtp.one.com',
    smtpPort: 587,
  }
};

class IMAPClient {
  private config: EmailConfig;
  
  constructor(config: EmailConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    console.log(`Connecting to IMAP: ${this.config.imapHost}:${this.config.imapPort}`);
    // Basic IMAP implementation using fetch for simplicity
    // In production, you'd use a proper IMAP library
  }

  async fetchEmails(folder = 'INBOX', limit = 20): Promise<EmailMessage[]> {
    console.log(`Fetching emails from ${folder}, limit: ${limit}`);
    
    // Mock implementation - replace with actual IMAP protocol
    const mockEmails: EmailMessage[] = [
      {
        id: '1',
        from: 'test@example.com',
        to: this.config.email,
        subject: 'Test Email',
        body: 'This is a test email from IMAP service',
        date: new Date().toISOString(),
        isRead: false,
      }
    ];

    return mockEmails;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<boolean> {
    console.log(`Sending email to: ${to}, subject: ${subject}`);
    
    // Mock implementation - replace with actual SMTP protocol
    console.log('Email sent successfully (mock)');
    return true;
  }
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Request method:', req.method);
    console.log('Request headers:', Object.fromEntries(req.headers.entries()));
    
    if (req.method === 'POST') {
      let body;
      try {
        const text = await req.text();
        console.log('Raw request body:', text);
        body = text ? JSON.parse(text) : {};
      } catch (error) {
        console.error('JSON parsing error:', error);
        return new Response(
          JSON.stringify({ error: 'Invalid JSON in request body' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      
      const action = body.action;
      console.log('Email service request:', { action, body });

      switch (action) {
        case 'test-connection': {
          const { provider, email, password, customConfig } = body as {
            provider: string;
            email: string;
            password: string;
            customConfig?: Partial<EmailConfig>;
          };

          if (!provider || !email || !password) {
            return new Response(
              JSON.stringify({ error: 'Missing required fields: provider, email, password' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }

          const config: EmailConfig = {
            provider: provider as EmailConfig['provider'],
            email,
            password,
            ...PROVIDER_CONFIGS[provider as keyof typeof PROVIDER_CONFIGS],
            ...customConfig,
          };

          console.log('Testing connection with config:', { 
            provider, 
            email, 
            imapHost: config.imapHost,
            imapPort: config.imapPort 
          });

          const client = new IMAPClient(config);
          await client.connect();

          return new Response(
            JSON.stringify({ 
              success: true, 
              message: 'Connection successful',
              config: {
                provider: config.provider,
                imapHost: config.imapHost,
                imapPort: config.imapPort,
              }
            }),
            { 
              status: 200, 
              headers: { 'Content-Type': 'application/json', ...corsHeaders } 
            }
          );
        }

        case 'fetch-emails': {
          const { config, folder, limit } = body as {
            config: EmailConfig;
            folder?: string;
            limit?: number;
          };

          const client = new IMAPClient(config);
          await client.connect();
          const emails = await client.fetchEmails(folder, limit);

          return new Response(
            JSON.stringify({ success: true, emails }),
            { 
              status: 200, 
              headers: { 'Content-Type': 'application/json', ...corsHeaders } 
            }
          );
        }

        case 'send-email': {
          const { config, to, subject, body: emailBody } = body as {
            config: EmailConfig;
            to: string;
            subject: string;
            body: string;
          };

          const client = new IMAPClient(config);
          const success = await client.sendEmail(to, subject, emailBody);

          return new Response(
            JSON.stringify({ success, message: success ? 'Email sent' : 'Failed to send email' }),
            { 
              status: success ? 200 : 500, 
              headers: { 'Content-Type': 'application/json', ...corsHeaders } 
            }
          );
        }

        case 'imap-list': {
          const { config, limit: maxResults } = body as {
            config: EmailConfig;
            limit?: number;
          };

          // NOTE: IMAP listing is mocked for now. Replace with real IMAP protocol implementation.
          const limit = Math.min(Math.max(maxResults || 50, 1), 200);
          const now = Date.now();
          const emails: EmailMessage[] = Array.from({ length: limit }).map((_, i) => ({
            id: `${i + 1}`,
            from: i % 3 === 0 ? 'billing@vendor.com' : 'team@company.com',
            to: config.email,
            subject: i % 5 === 0 ? `Faktura #${1000 + i}` : `Uppdatering ${i + 1}`,
            body: 'Sammanfattning av meddelandet... (demo)',
            date: new Date(now - i * 3600_000).toISOString(),
            isRead: i % 4 !== 0,
          }));

          return new Response(
            JSON.stringify({ success: true, count: emails.length, emails }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        case 'gmail-list': {
          const { accessToken, maxResults } = body as {
            accessToken: string;
            maxResults?: number;
          };

          if (!accessToken) {
            return new Response(
              JSON.stringify({ error: 'Missing accessToken for Gmail API' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }

          const limit = Math.min(Math.max(maxResults || 50, 1), 200);

          const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&labelIds=INBOX`;
          const listResp = await fetch(listUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });

          const listJson = await listResp.json();
          if (!listResp.ok) {
            console.error('Gmail list error:', listJson);
            return new Response(
              JSON.stringify({ error: listJson.error?.message || 'Failed to list Gmail messages' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }

          const messages: { id: string }[] = listJson.messages || [];

          const getHeader = (headers: any[], name: string) => {
            const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
            return h?.value || '';
          };

          const results = await Promise.allSettled(
            messages.map(async (m) => {
              const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`;
              const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
              const j = await r.json();
              if (!r.ok) throw new Error(j.error?.message || 'Failed to fetch message');
              const headers = j.payload?.headers || [];
              const email: EmailMessage = {
                id: j.id,
                from: getHeader(headers, 'From'),
                to: getHeader(headers, 'To'),
                subject: getHeader(headers, 'Subject') || '(ingen ämnesrad)',
                body: j.snippet || '',
                date: getHeader(headers, 'Date') || new Date(parseInt(j.internalDate || '0', 10)).toISOString(),
                isRead: !(j.labelIds || []).includes('UNREAD'),
              };
              return email;
            })
          );

          const emails: EmailMessage[] = results
            .filter((r) => r.status === 'fulfilled')
            .map((r: any) => r.value);

          return new Response(
            JSON.stringify({ success: true, count: emails.length, emails }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        default:
          return new Response(
            JSON.stringify({ error: 'Invalid action' }),
            { 
              status: 400, 
              headers: { 'Content-Type': 'application/json', ...corsHeaders } 
            }
          );
      }
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { 
        status: 405, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      }
    );

  } catch (error: any) {
    console.error('Error in email-service function:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Internal server error',
        details: error.stack 
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
});