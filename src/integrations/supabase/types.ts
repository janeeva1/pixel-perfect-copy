export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attendance_imports: {
        Row: {
          created_at: string
          file_name: string
          id: string
          row_count: number
          session_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          row_count?: number
          session_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          row_count?: number
          session_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attendance_imports_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_records: {
        Row: {
          created_at: string
          first_scan_at: string | null
          id: string
          last_scan_at: string | null
          match_method: string | null
          person_id: string
          scan_count: number
          session_id: string
          status: Database["public"]["Enums"]["attendance_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          first_scan_at?: string | null
          id?: string
          last_scan_at?: string | null
          match_method?: string | null
          person_id: string
          scan_count?: number
          session_id: string
          status: Database["public"]["Enums"]["attendance_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          first_scan_at?: string | null
          id?: string
          last_scan_at?: string | null
          match_method?: string | null
          person_id?: string
          scan_count?: number
          session_id?: string
          status?: Database["public"]["Enums"]["attendance_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_sessions: {
        Row: {
          created_at: string
          created_by: string | null
          department_id: string | null
          finalized_at: string | null
          id: string
          level: string | null
          notes: string | null
          person_type: Database["public"]["Enums"]["person_type"]
          session_date: string
          staff_category: string | null
          status: Database["public"]["Enums"]["session_status"]
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          finalized_at?: string | null
          id?: string
          level?: string | null
          notes?: string | null
          person_type: Database["public"]["Enums"]["person_type"]
          session_date: string
          staff_category?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          finalized_at?: string | null
          id?: string
          level?: string | null
          notes?: string | null
          person_type?: Database["public"]["Enums"]["person_type"]
          session_date?: string
          staff_category?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_sessions_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json | null
          entity: string | null
          entity_id: string | null
          id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          entity?: string | null
          entity_id?: string | null
          id?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          entity?: string | null
          entity_id?: string | null
          id?: string
        }
        Relationships: []
      }
      departments: {
        Row: {
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      import_rows: {
        Row: {
          created_at: string
          id: string
          import_id: string
          match_method: string | null
          match_status: Database["public"]["Enums"]["match_status"]
          matched_person_id: string | null
          note: string | null
          raw_code: string | null
          raw_name: string | null
          raw_scan_time: string | null
          row_number: number
          scan_at: string | null
          session_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          import_id: string
          match_method?: string | null
          match_status: Database["public"]["Enums"]["match_status"]
          matched_person_id?: string | null
          note?: string | null
          raw_code?: string | null
          raw_name?: string | null
          raw_scan_time?: string | null
          row_number: number
          scan_at?: string | null
          session_id: string
        }
        Update: {
          created_at?: string
          id?: string
          import_id?: string
          match_method?: string | null
          match_status?: Database["public"]["Enums"]["match_status"]
          matched_person_id?: string | null
          note?: string | null
          raw_code?: string | null
          raw_name?: string | null
          raw_scan_time?: string | null
          row_number?: number
          scan_at?: string | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "attendance_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_matched_person_id_fkey"
            columns: ["matched_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          biometric_id: string | null
          created_at: string
          deleted_at: string | null
          department_id: string | null
          email: string | null
          first_name: string | null
          full_name: string
          id: string
          last_name: string | null
          level: string | null
          machine_key: string | null
          matric_no: string | null
          middle_name: string | null
          normalized_name: string
          person_code: string
          person_type: Database["public"]["Enums"]["person_type"]
          phone: string | null
          programme: string | null
          source_id: string | null
          staff_category: string | null
          staff_no: string | null
          status: Database["public"]["Enums"]["person_status"]
          updated_at: string
        }
        Insert: {
          biometric_id?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          email?: string | null
          first_name?: string | null
          full_name: string
          id?: string
          last_name?: string | null
          level?: string | null
          machine_key?: string | null
          matric_no?: string | null
          middle_name?: string | null
          normalized_name: string
          person_code: string
          person_type: Database["public"]["Enums"]["person_type"]
          phone?: string | null
          programme?: string | null
          source_id?: string | null
          staff_category?: string | null
          staff_no?: string | null
          status?: Database["public"]["Enums"]["person_status"]
          updated_at?: string
        }
        Update: {
          biometric_id?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string
          id?: string
          last_name?: string | null
          level?: string | null
          machine_key?: string | null
          matric_no?: string | null
          middle_name?: string | null
          normalized_name?: string
          person_code?: string
          person_type?: Database["public"]["Enums"]["person_type"]
          phone?: string | null
          programme?: string | null
          source_id?: string | null
          staff_category?: string | null
          staff_no?: string | null
          status?: Database["public"]["Enums"]["person_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "people_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      session_population: {
        Row: {
          created_at: string
          full_name: string
          id: string
          machine_key: string | null
          normalized_name: string
          person_code: string
          person_id: string
          session_id: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id?: string
          machine_key?: string | null
          normalized_name: string
          person_code: string
          person_id: string
          session_id: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          machine_key?: string | null
          normalized_name?: string
          person_code?: string
          person_id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_population_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_population_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "attendance_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_edit: { Args: { _user_id: string }; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "operator" | "viewer"
      attendance_status: "present" | "absent"
      match_status: "matched" | "out_of_scope" | "unmatched"
      person_status: "active" | "inactive"
      person_type: "student" | "staff"
      session_status: "draft" | "finalized"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operator", "viewer"],
      attendance_status: ["present", "absent"],
      match_status: ["matched", "out_of_scope", "unmatched"],
      person_status: ["active", "inactive"],
      person_type: ["student", "staff"],
      session_status: ["draft", "finalized"],
    },
  },
} as const
