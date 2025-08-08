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
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    
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