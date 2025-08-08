export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instanciate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.4"
  }
  public: {
    Tables: {
      agent_conversations: {
        Row: {
          agent_id: string | null
          content: string
          created_at: string
          id: string
          message_type: string
          metadata: Json | null
          session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          content: string
          created_at?: string
          id?: string
          message_type: string
          metadata?: Json | null
          session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          content?: string
          created_at?: string
          id?: string
          message_type?: string
          metadata?: Json | null
          session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_memory: {
        Row: {
          agent_id: string | null
          content: Json
          created_at: string | null
          expires_at: string | null
          id: string
          memory_type: string
          metadata: Json | null
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          content: Json
          created_at?: string | null
          expires_at?: string | null
          id?: string
          memory_type: string
          metadata?: Json | null
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          content?: Json
          created_at?: string | null
          expires_at?: string | null
          id?: string
          memory_type?: string
          metadata?: Json | null
          updated_at?: string | null
        }
        Relationships: []
      }
      agent_templates: {
        Row: {
          agent_type: string
          created_at: string
          default_configuration: Json | null
          description: string | null
          id: string
          interaction_style: Json | null
          name: string
          prompt_template: string | null
          required_integrations: string[] | null
          updated_at: string
        }
        Insert: {
          agent_type: string
          created_at?: string
          default_configuration?: Json | null
          description?: string | null
          id?: string
          interaction_style?: Json | null
          name: string
          prompt_template?: string | null
          required_integrations?: string[] | null
          updated_at?: string
        }
        Update: {
          agent_type?: string
          created_at?: string
          default_configuration?: Json | null
          description?: string | null
          id?: string
          interaction_style?: Json | null
          name?: string
          prompt_template?: string | null
          required_integrations?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      agent_types: {
        Row: {
          capabilities: string[] | null
          created_at: string | null
          default_config: Json | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          required_integrations: string[] | null
        }
        Insert: {
          capabilities?: string[] | null
          created_at?: string | null
          default_config?: Json | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          required_integrations?: string[] | null
        }
        Update: {
          capabilities?: string[] | null
          created_at?: string | null
          default_config?: Json | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          required_integrations?: string[] | null
        }
        Relationships: []
      }
      agent_workflows: {
        Row: {
          agent_id: string | null
          created_at: string | null
          edges: Json | null
          id: string
          is_active: boolean | null
          metadata: Json | null
          nodes: Json | null
          updated_at: string | null
          workflow_name: string
        }
        Insert: {
          agent_id?: string | null
          created_at?: string | null
          edges?: Json | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          nodes?: Json | null
          updated_at?: string | null
          workflow_name: string
        }
        Update: {
          agent_id?: string | null
          created_at?: string | null
          edges?: Json | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          nodes?: Json | null
          updated_at?: string | null
          workflow_name?: string
        }
        Relationships: []
      }
      agents: {
        Row: {
          agent_role: string | null
          agent_type: string
          api_integrations: Json | null
          configuration: Json | null
          created_at: string
          description: string | null
          id: string
          interaction_style: Json | null
          last_activity: string | null
          memory_context: Json | null
          name: string
          parent_agent_id: string | null
          performance_data: Json | null
          status: string | null
          team_position: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_role?: string | null
          agent_type: string
          api_integrations?: Json | null
          configuration?: Json | null
          created_at?: string
          description?: string | null
          id?: string
          interaction_style?: Json | null
          last_activity?: string | null
          memory_context?: Json | null
          name: string
          parent_agent_id?: string | null
          performance_data?: Json | null
          status?: string | null
          team_position?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_role?: string | null
          agent_type?: string
          api_integrations?: Json | null
          configuration?: Json | null
          created_at?: string
          description?: string | null
          id?: string
          interaction_style?: Json | null
          last_activity?: string | null
          memory_context?: Json | null
          name?: string
          parent_agent_id?: string | null
          performance_data?: Json | null
          status?: string | null
          team_position?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_sessions: {
        Row: {
          bot_id: string | null
          created_at: string
          failed_trades: number | null
          id: string
          interval_ms: number | null
          last_cycle_at: string | null
          status: string | null
          successful_trades: number | null
          symbols: string[] | null
          total_cycles: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          created_at?: string
          failed_trades?: number | null
          id?: string
          interval_ms?: number | null
          last_cycle_at?: string | null
          status?: string | null
          successful_trades?: number | null
          symbols?: string[] | null
          total_cycles?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string | null
          created_at?: string
          failed_trades?: number | null
          id?: string
          interval_ms?: number | null
          last_cycle_at?: string | null
          status?: string | null
          successful_trades?: number | null
          symbols?: string[] | null
          total_cycles?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_sessions_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      coordinator_sessions: {
        Row: {
          active_agents: string[] | null
          context: Json | null
          created_at: string | null
          id: string
          last_activity: string | null
          session_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          active_agents?: string[] | null
          context?: Json | null
          created_at?: string | null
          id?: string
          last_activity?: string | null
          session_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          active_agents?: string[] | null
          context?: Json | null
          created_at?: string | null
          id?: string
          last_activity?: string | null
          session_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          subscription_tier: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          subscription_tier?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          subscription_tier?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      service_credentials: {
        Row: {
          config: Json
          created_at: string
          email: string | null
          encrypted_secret: string
          host: string | null
          id: string
          iv: string
          port: number | null
          service: string
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          config?: Json
          created_at?: string
          email?: string | null
          encrypted_secret: string
          host?: string | null
          id?: string
          iv: string
          port?: number | null
          service: string
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          config?: Json
          created_at?: string
          email?: string | null
          encrypted_secret?: string
          host?: string | null
          id?: string
          iv?: string
          port?: number | null
          service?: string
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          bot_id: string | null
          confidence: number | null
          created_at: string
          executed_at: string | null
          id: string
          price: number
          quantity: number
          risk_score: number | null
          side: string
          status: string | null
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          confidence?: number | null
          created_at?: string
          executed_at?: string | null
          id?: string
          price: number
          quantity: number
          risk_score?: number | null
          side: string
          status?: string | null
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string | null
          confidence?: number | null
          created_at?: string
          executed_at?: string | null
          id?: string
          price?: number
          quantity?: number
          risk_score?: number | null
          side?: string
          status?: string | null
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
