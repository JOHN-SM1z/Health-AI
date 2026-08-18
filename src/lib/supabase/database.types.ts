export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      analytics_events: {
        Row: {
          clinic_id: string
          created_at: string
          event_type: string
          id: string
          patient_id: string | null
          payload: Json
        }
        Insert: {
          clinic_id: string
          created_at?: string
          event_type: string
          id?: string
          patient_id?: string | null
          payload?: Json
        }
        Update: {
          clinic_id?: string
          created_at?: string
          event_type?: string
          id?: string
          patient_id?: string | null
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "analytics_events_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          clinic_id: string
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          clinic_id: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          clinic_id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          cancelled_at: string | null
          cancelled_by: string | null
          cancelled_reason: string | null
          clinic_id: string
          created_at: string
          created_by: string | null
          doctor_id: string
          end_at: string
          id: string
          notes: string | null
          patient_id: string
          service_id: string
          source: Database["public"]["Enums"]["appointment_source"]
          start_at: string
          status: Database["public"]["Enums"]["appointment_status"]
          updated_at: string
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          clinic_id: string
          created_at?: string
          created_by?: string | null
          doctor_id: string
          end_at: string
          id?: string
          notes?: string | null
          patient_id: string
          service_id: string
          source?: Database["public"]["Enums"]["appointment_source"]
          start_at: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Update: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          doctor_id?: string
          end_at?: string
          id?: string
          notes?: string | null
          patient_id?: string
          service_id?: string
          source?: Database["public"]["Enums"]["appointment_source"]
          start_at?: string
          status?: Database["public"]["Enums"]["appointment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          clinic_id: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          ip_address: string | null
          metadata: Json
          new_values: Json | null
          old_values: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          clinic_id: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          new_values?: Json | null
          old_values?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          clinic_id?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          new_values?: Json | null
          old_values?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_telegram_integrations: {
        Row: {
          clinic_id: string
          created_at: string
          enabled: boolean
          last_error: string | null
          status: Database["public"]["Enums"]["telegram_bot_status"]
          telegram_bot_id: number | null
          telegram_bot_name: string | null
          telegram_bot_token: string | null
          telegram_username: string | null
          updated_at: string
          validated_at: string | null
          webhook_error: string | null
          webhook_status: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          enabled?: boolean
          last_error?: string | null
          status?: Database["public"]["Enums"]["telegram_bot_status"]
          telegram_bot_id?: number | null
          telegram_bot_name?: string | null
          telegram_bot_token?: string | null
          telegram_username?: string | null
          updated_at?: string
          validated_at?: string | null
          webhook_error?: string | null
          webhook_status?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          enabled?: boolean
          last_error?: string | null
          status?: Database["public"]["Enums"]["telegram_bot_status"]
          telegram_bot_id?: number | null
          telegram_bot_name?: string | null
          telegram_bot_token?: string | null
          telegram_username?: string | null
          updated_at?: string
          validated_at?: string | null
          webhook_error?: string | null
          webhook_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clinic_telegram_integrations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: true
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinics: {
        Row: {
          address: string | null
          created_at: string
          currency: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          opening_hours: Json
          phone: string | null
          privacy_notice: string | null
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          currency?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          opening_hours?: Json
          phone?: string | null
          privacy_notice?: string | null
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          currency?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          opening_hours?: Json
          phone?: string | null
          privacy_notice?: string | null
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          ai_enabled: boolean
          channel: Database["public"]["Enums"]["conversation_channel"]
          clinic_id: string
          created_at: string
          id: string
          last_message_at: string | null
          patient_id: string
          released_at: string | null
          state: Json
          status: Database["public"]["Enums"]["conversation_status"]
          summary: string | null
          taken_over_at: string | null
          taken_over_by: string | null
          updated_at: string
        }
        Insert: {
          ai_enabled?: boolean
          channel?: Database["public"]["Enums"]["conversation_channel"]
          clinic_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          patient_id: string
          released_at?: string | null
          state?: Json
          status?: Database["public"]["Enums"]["conversation_status"]
          summary?: string | null
          taken_over_at?: string | null
          taken_over_by?: string | null
          updated_at?: string
        }
        Update: {
          ai_enabled?: boolean
          channel?: Database["public"]["Enums"]["conversation_channel"]
          clinic_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          patient_id?: string
          released_at?: string | null
          state?: Json
          status?: Database["public"]["Enums"]["conversation_status"]
          summary?: string | null
          taken_over_at?: string | null
          taken_over_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_taken_over_by_fkey"
            columns: ["taken_over_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_services: {
        Row: {
          doctor_id: string
          duration_override_minutes: number | null
          price_override: number | null
          service_id: string
        }
        Insert: {
          doctor_id: string
          duration_override_minutes?: number | null
          price_override?: number | null
          service_id: string
        }
        Update: {
          doctor_id?: string
          duration_override_minutes?: number | null
          price_override?: number | null
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_services_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_time_blocks: {
        Row: {
          clinic_id: string
          created_at: string
          created_by: string | null
          doctor_id: string
          ends_at: string
          id: string
          note: string | null
          reason: Database["public"]["Enums"]["time_block_reason"]
          starts_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          created_by?: string | null
          doctor_id: string
          ends_at: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["time_block_reason"]
          starts_at: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          doctor_id?: string
          ends_at?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["time_block_reason"]
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_time_blocks_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_time_blocks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_time_blocks_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_working_hours: {
        Row: {
          clinic_id: string
          doctor_id: string
          end_time: string
          id: string
          start_time: string
          weekday: number
        }
        Insert: {
          clinic_id: string
          doctor_id: string
          end_time: string
          id?: string
          start_time: string
          weekday: number
        }
        Update: {
          clinic_id?: string
          doctor_id?: string
          end_time?: string
          id?: string
          start_time?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "doctor_working_hours_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_working_hours_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctors: {
        Row: {
          active: boolean
          bio: string | null
          clinic_id: string
          created_at: string
          id: string
          name: string
          photo_url: string | null
          profile_id: string | null
          specialty_id: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          bio?: string | null
          clinic_id: string
          created_at?: string
          id?: string
          name: string
          photo_url?: string | null
          profile_id?: string | null
          specialty_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          bio?: string | null
          clinic_id?: string
          created_at?: string
          id?: string
          name?: string
          photo_url?: string | null
          profile_id?: string | null
          specialty_id?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctors_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctors_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctors_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      faq_entries: {
        Row: {
          active: boolean
          answer: string
          category: string | null
          clinic_id: string
          created_at: string
          id: string
          question: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          answer: string
          category?: string | null
          clinic_id: string
          created_at?: string
          id?: string
          question: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          answer?: string
          category?: string | null
          clinic_id?: string
          created_at?: string
          id?: string
          question?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "faq_entries_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          clinic_id: string
          content: string
          conversation_id: string
          created_at: string
          id: string
          metadata: Json
          role: Database["public"]["Enums"]["message_role"]
          telegram_message_id: number | null
          type: Database["public"]["Enums"]["message_type"]
          voice_message_id: string | null
        }
        Insert: {
          clinic_id: string
          content?: string
          conversation_id: string
          created_at?: string
          id?: string
          metadata?: Json
          role: Database["public"]["Enums"]["message_role"]
          telegram_message_id?: number | null
          type?: Database["public"]["Enums"]["message_type"]
          voice_message_id?: string | null
        }
        Update: {
          clinic_id?: string
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          role?: Database["public"]["Enums"]["message_role"]
          telegram_message_id?: number | null
          type?: Database["public"]["Enums"]["message_type"]
          voice_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_voice_message_id_fkey"
            columns: ["voice_message_id"]
            isOneToOne: false
            referencedRelation: "voice_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_jobs: {
        Row: {
          appointment_id: string | null
          attempts: number
          channel: string
          clinic_id: string
          conversation_id: string | null
          created_at: string
          error: string | null
          id: string
          idempotency_key: string
          max_attempts: number
          patient_telegram_user_id: number | null
          recipient_type: string
          scheduled_for: string
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_job_status"]
          telegram_message_id: number | null
          type: Database["public"]["Enums"]["notification_job_type"]
          updated_at: string
        }
        Insert: {
          appointment_id?: string | null
          attempts?: number
          channel?: string
          clinic_id: string
          conversation_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key: string
          max_attempts?: number
          patient_telegram_user_id?: number | null
          recipient_type?: string
          scheduled_for: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_job_status"]
          telegram_message_id?: number | null
          type: Database["public"]["Enums"]["notification_job_type"]
          updated_at?: string
        }
        Update: {
          appointment_id?: string | null
          attempts?: number
          channel?: string
          clinic_id?: string
          conversation_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string
          max_attempts?: number
          patient_telegram_user_id?: number | null
          recipient_type?: string
          scheduled_for?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_job_status"]
          telegram_message_id?: number | null
          type?: Database["public"]["Enums"]["notification_job_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_jobs_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_jobs_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_jobs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          clinic_id: string
          consent_given: boolean
          consent_given_at: string | null
          created_at: string
          full_name: string | null
          id: string
          last_seen_at: string | null
          phone: string | null
          preferred_language: string
          telegram_first_name: string | null
          telegram_last_name: string | null
          telegram_user_id: number | null
          telegram_username: string | null
          updated_at: string
        }
        Insert: {
          clinic_id: string
          consent_given?: boolean
          consent_given_at?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          last_seen_at?: string | null
          phone?: string | null
          preferred_language?: string
          telegram_first_name?: string | null
          telegram_last_name?: string | null
          telegram_user_id?: number | null
          telegram_username?: string | null
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          consent_given?: boolean
          consent_given_at?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          last_seen_at?: string | null
          phone?: string | null
          preferred_language?: string
          telegram_first_name?: string | null
          telegram_last_name?: string | null
          telegram_user_id?: number | null
          telegram_username?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patients_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          appointment_id: string
          clinic_id: string
          created_at: string
          currency: string
          id: string
          metadata: Json
          paid_at: string | null
          paid_by: string | null
          patient_id: string
          payment_url: string | null
          provider: Database["public"]["Enums"]["payment_provider"]
          provider_reference: string | null
          status: Database["public"]["Enums"]["payment_status"]
          updated_at: string
        }
        Insert: {
          amount: number
          appointment_id: string
          clinic_id: string
          created_at?: string
          currency?: string
          id?: string
          metadata?: Json
          paid_at?: string | null
          paid_by?: string | null
          patient_id: string
          payment_url?: string | null
          provider?: Database["public"]["Enums"]["payment_provider"]
          provider_reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Update: {
          amount?: number
          appointment_id?: string
          clinic_id?: string
          created_at?: string
          currency?: string
          id?: string
          metadata?: Json
          paid_at?: string | null
          paid_by?: string | null
          patient_id?: string
          payment_url?: string | null
          provider?: Database["public"]["Enums"]["payment_provider"]
          provider_reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          profile_id: string
        }
        Update: {
          created_at?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_admins_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_webhooks: {
        Row: {
          external_id: string
          payload_hash: string | null
          processed_at: string
          source: string
          status: string
        }
        Insert: {
          external_id: string
          payload_hash?: string | null
          processed_at?: string
          source: string
          status?: string
        }
        Update: {
          external_id?: string
          payload_hash?: string | null
          processed_at?: string
          source?: string
          status?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          active: boolean
          clinic_id: string
          created_at: string
          description: string | null
          duration_minutes: number
          id: string
          name: string
          preparation_text: string | null
          price: number
          sort_order: number
          specialty_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          clinic_id: string
          created_at?: string
          description?: string | null
          duration_minutes: number
          id?: string
          name: string
          preparation_text?: string | null
          price?: number
          sort_order?: number
          specialty_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          clinic_id?: string
          created_at?: string
          description?: string | null
          duration_minutes?: number
          id?: string
          name?: string
          preparation_text?: string | null
          price?: number
          sort_order?: number
          specialty_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      specialties: {
        Row: {
          active: boolean
          clinic_id: string
          created_at: string
          description: string | null
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          clinic_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          clinic_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "specialties_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_roles: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          profile_id: string
          role: Database["public"]["Enums"]["staff_role"]
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          profile_id: string
          role: Database["public"]["Enums"]["staff_role"]
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          profile_id?: string
          role?: Database["public"]["Enums"]["staff_role"]
        }
        Relationships: [
          {
            foreignKeyName: "staff_roles_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_roles_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_messages: {
        Row: {
          clinic_id: string
          consent_given: boolean
          conversation_id: string
          corrected_transcription: string | null
          created_at: string
          duration_seconds: number | null
          expires_at: string | null
          id: string
          mime_type: string | null
          retention_days: number
          size_bytes: number | null
          storage_path: string | null
          telegram_file_id: string | null
          telegram_file_unique_id: string | null
          transcription: string | null
          transcription_error: string | null
          transcription_provider: string | null
          transcription_status: Database["public"]["Enums"]["voice_status"]
          updated_at: string
        }
        Insert: {
          clinic_id: string
          consent_given?: boolean
          conversation_id: string
          corrected_transcription?: string | null
          created_at?: string
          duration_seconds?: number | null
          expires_at?: string | null
          id?: string
          mime_type?: string | null
          retention_days?: number
          size_bytes?: number | null
          storage_path?: string | null
          telegram_file_id?: string | null
          telegram_file_unique_id?: string | null
          transcription?: string | null
          transcription_error?: string | null
          transcription_provider?: string | null
          transcription_status?: Database["public"]["Enums"]["voice_status"]
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          consent_given?: boolean
          conversation_id?: string
          corrected_transcription?: string | null
          created_at?: string
          duration_seconds?: number | null
          expires_at?: string | null
          id?: string
          mime_type?: string | null
          retention_days?: number
          size_bytes?: number | null
          storage_path?: string | null
          telegram_file_id?: string | null
          telegram_file_unique_id?: string | null
          transcription?: string | null
          transcription_error?: string | null
          transcription_provider?: string | null
          transcription_status?: Database["public"]["Enums"]["voice_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_messages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      book_appointment: {
        Args: {
          p_clinic_id: string
          p_created_by?: string
          p_doctor_id: string
          p_notes?: string
          p_patient_id: string
          p_service_id: string
          p_source?: Database["public"]["Enums"]["appointment_source"]
          p_start_at: string
          p_status?: Database["public"]["Enums"]["appointment_status"]
        }
        Returns: Record<string, unknown>
      }
      claim_due_notification_jobs: {
        Args: { p_limit: number }
        Returns: {
          appointment_id: string | null
          attempts: number
          channel: string
          clinic_id: string
          conversation_id: string | null
          created_at: string
          error: string | null
          id: string
          idempotency_key: string
          max_attempts: number
          patient_telegram_user_id: number | null
          recipient_type: string
          scheduled_for: string
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_job_status"]
          telegram_message_id: number | null
          type: Database["public"]["Enums"]["notification_job_type"]
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "notification_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_webhook_update: {
        Args: { p_external_id: string; p_source: string }
        Returns: boolean
      }
      finish_webhook_update: {
        Args: { p_external_id: string; p_source: string }
        Returns: undefined
      }
      is_clinic_staff: {
        Args: {
          p_clinic_id: string
          p_roles?: Database["public"]["Enums"]["staff_role"][]
        }
        Returns: boolean
      }
      is_platform_admin: { Args: never; Returns: boolean }
      release_webhook_update: {
        Args: { p_external_id: string; p_source: string }
        Returns: undefined
      }
      reschedule_appointment: {
        Args: {
          p_actor?: string
          p_appointment_id: string
          p_new_start_at: string
        }
        Returns: Record<string, unknown>
      }
    }
    Enums: {
      actor_type: "staff" | "system" | "patient" | "telegram"
      appointment_source:
        | "telegram_mini_app"
        | "telegram_chat"
        | "admin"
        | "walk_in"
      appointment_status:
        | "pending"
        | "confirmed"
        | "checked_in"
        | "in_progress"
        | "completed"
        | "cancelled"
        | "no_show"
      conversation_channel: "telegram" | "mini_app"
      conversation_status: "open" | "assigned" | "released" | "closed"
      message_role: "patient" | "bot" | "ai" | "admin" | "system"
      message_type: "text" | "voice" | "button" | "callback" | "system"
      notification_job_status:
        | "pending"
        | "in_progress"
        | "sent"
        | "failed"
        | "skipped"
        | "cancelled"
      notification_job_type:
        | "booking_confirmation"
        | "reminder_24h"
        | "reminder_2h"
        | "cancellation"
        | "reschedule"
        | "human_takeover"
      payment_provider: "manual" | "click" | "payme" | "cash" | "card_terminal"
      payment_status:
        | "unpaid"
        | "pending"
        | "paid"
        | "failed"
        | "refunded"
        | "manual_review"
      staff_role: "owner" | "manager" | "admin" | "receptionist" | "doctor"
      telegram_bot_status: "disabled" | "active" | "error"
      time_block_reason: "break" | "absence" | "reservation" | "admin_hold"
      voice_status: "none" | "pending" | "transcribed" | "failed"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      actor_type: ["staff", "system", "patient", "telegram"],
      appointment_source: [
        "telegram_mini_app",
        "telegram_chat",
        "admin",
        "walk_in",
      ],
      appointment_status: [
        "pending",
        "confirmed",
        "checked_in",
        "in_progress",
        "completed",
        "cancelled",
        "no_show",
      ],
      conversation_channel: ["telegram", "mini_app"],
      conversation_status: ["open", "assigned", "released", "closed"],
      message_role: ["patient", "bot", "ai", "admin", "system"],
      message_type: ["text", "voice", "button", "callback", "system"],
      notification_job_status: [
        "pending",
        "in_progress",
        "sent",
        "failed",
        "skipped",
        "cancelled",
      ],
      notification_job_type: [
        "booking_confirmation",
        "reminder_24h",
        "reminder_2h",
        "cancellation",
        "reschedule",
        "human_takeover",
      ],
      payment_provider: ["manual", "click", "payme", "cash", "card_terminal"],
      payment_status: [
        "unpaid",
        "pending",
        "paid",
        "failed",
        "refunded",
        "manual_review",
      ],
      staff_role: ["owner", "manager", "admin", "receptionist", "doctor"],
      telegram_bot_status: ["disabled", "active", "error"],
      time_block_reason: ["break", "absence", "reservation", "admin_hold"],
      voice_status: ["none", "pending", "transcribed", "failed"],
    },
  },
} as const

