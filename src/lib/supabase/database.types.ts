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
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
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
          idempotency_key: string | null
          no_show_reason: string | null
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
          idempotency_key?: string | null
          no_show_reason?: string | null
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
          idempotency_key?: string | null
          no_show_reason?: string | null
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
            columns: ["doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id", "clinic_id"]
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
          patient_id: string | null
          referral_id: string | null
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
          patient_id?: string | null
          referral_id?: string | null
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
          patient_id?: string | null
          referral_id?: string | null
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
      clinical_records: {
        Row: {
          appointment_id: string
          author_doctor_id: string
          clinic_id: string
          code: string | null
          corrects_record_id: string | null
          created_at: string
          created_by: string
          creation_key: string | null
          details: string | null
          id: string
          patient_id: string
          record_type: Database["public"]["Enums"]["clinical_record_type"]
          summary: string
        }
        Insert: {
          appointment_id: string
          author_doctor_id: string
          clinic_id: string
          code?: string | null
          corrects_record_id?: string | null
          created_at?: string
          created_by: string
          creation_key?: string | null
          details?: string | null
          id?: string
          patient_id: string
          record_type: Database["public"]["Enums"]["clinical_record_type"]
          summary: string
        }
        Update: {
          appointment_id?: string
          author_doctor_id?: string
          clinic_id?: string
          code?: string | null
          corrects_record_id?: string | null
          created_at?: string
          created_by?: string
          creation_key?: string | null
          details?: string | null
          id?: string
          patient_id?: string
          record_type?: Database["public"]["Enums"]["clinical_record_type"]
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinical_records_author_same_clinic_fkey"
            columns: ["author_doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "clinical_records_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clinical_records_consultation_fkey"
            columns: ["appointment_id", "clinic_id", "patient_id", "author_doctor_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id", "patient_id", "doctor_id"]
          },
          {
            foreignKeyName: "clinical_records_corrects_record_id_fkey"
            columns: ["corrects_record_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "clinical_records"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "clinical_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clinical_records_patient_same_clinic_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
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
          admin_seen_at: string | null
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
          urgent_at: string | null
        }
        Insert: {
          admin_seen_at?: string | null
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
          urgent_at?: string | null
        }
        Update: {
          admin_seen_at?: string | null
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
          urgent_at?: string | null
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
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
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
            columns: ["doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
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
            columns: ["doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
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
            columns: ["specialty_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id", "clinic_id"]
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
      lab_documents: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["lab_document_kind"]
          mime_type: string
          order_id: string
          patient_id: string
          result_id: string | null
          sha256: string
          size_bytes: number
          storage_path: string
          uploaded_by: string
          withdraw_reason: string | null
          withdrawn_at: string | null
          withdrawn_by: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["lab_document_kind"]
          mime_type: string
          order_id: string
          patient_id: string
          result_id?: string | null
          sha256: string
          size_bytes: number
          storage_path: string
          uploaded_by: string
          withdraw_reason?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["lab_document_kind"]
          mime_type?: string
          order_id?: string
          patient_id?: string
          result_id?: string | null
          sha256?: string
          size_bytes?: number
          storage_path?: string
          uploaded_by?: string
          withdraw_reason?: string | null
          withdrawn_at?: string | null
          withdrawn_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lab_documents_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_documents_order_fkey"
            columns: ["order_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "clinic_id", "patient_id"]
          },
          {
            foreignKeyName: "lab_documents_result_fkey"
            columns: ["result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_documents_withdrawn_by_fkey"
            columns: ["withdrawn_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_external_requests: {
        Row: {
          attempts: number
          cancelled_at: string | null
          cancelled_by: string | null
          clinic_id: string
          external_order_id: string | null
          external_result_id: string | null
          id: string
          last_error_code: string | null
          lease_until: string | null
          next_attempt_at: string
          order_item_id: string
          patient_id: string
          provider_id: string
          requested_at: string
          requested_by: string
          result_id: string | null
          resulted_at: string | null
          review_reason: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["lab_external_status"]
          updated_at: string
        }
        Insert: {
          attempts?: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id: string
          external_order_id?: string | null
          external_result_id?: string | null
          id?: string
          last_error_code?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          order_item_id: string
          patient_id: string
          provider_id: string
          requested_at?: string
          requested_by: string
          result_id?: string | null
          resulted_at?: string | null
          review_reason?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["lab_external_status"]
          updated_at?: string
        }
        Update: {
          attempts?: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id?: string
          external_order_id?: string | null
          external_result_id?: string | null
          id?: string
          last_error_code?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          order_item_id?: string
          patient_id?: string
          provider_id?: string
          requested_at?: string
          requested_by?: string
          result_id?: string | null
          resulted_at?: string | null
          review_reason?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["lab_external_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_external_requests_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_external_requests_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_external_requests_item_fkey"
            columns: ["order_item_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_order_items"
            referencedColumns: ["id", "clinic_id", "patient_id"]
          },
          {
            foreignKeyName: "lab_external_requests_provider_fkey"
            columns: ["provider_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_providers"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_external_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_external_requests_result_fkey"
            columns: ["result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_provider_codes: {
        Row: {
          clinic_id: string
          created_at: string
          external_code: string
          id: string
          internal_id: string
          kind: string
          provider_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          external_code: string
          id?: string
          internal_id: string
          kind: string
          provider_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          external_code?: string
          id?: string
          internal_id?: string
          kind?: string
          provider_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_provider_codes_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_provider_codes_provider_fkey"
            columns: ["provider_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_providers"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_providers: {
        Row: {
          active: boolean
          adapter: string
          clinic_id: string
          code: string
          config: Json
          created_at: string
          created_by: string
          credential_ref: string | null
          id: string
          name: string
          send_patient_name: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          adapter: string
          clinic_id: string
          code: string
          config?: Json
          created_at?: string
          created_by: string
          credential_ref?: string | null
          id?: string
          name: string
          send_patient_name?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          adapter?: string
          clinic_id?: string
          code?: string
          config?: Json
          created_at?: string
          created_by?: string
          credential_ref?: string | null
          id?: string
          name?: string
          send_patient_name?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_providers_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_providers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_import_batches: {
        Row: {
          analysed_at: string | null
          analysed_by: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          clinic_id: string
          completed_at: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          created_by: string
          file_name: string
          file_sha256: string
          headers: Json
          id: string
          mapping: Json | null
          row_count: number
          source_system: string
          status: Database["public"]["Enums"]["lab_import_status"]
          summary: Json
          updated_at: string
        }
        Insert: {
          analysed_at?: string | null
          analysed_by?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id: string
          completed_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by: string
          file_name: string
          file_sha256: string
          headers: Json
          id?: string
          mapping?: Json | null
          row_count: number
          source_system: string
          status?: Database["public"]["Enums"]["lab_import_status"]
          summary?: Json
          updated_at?: string
        }
        Update: {
          analysed_at?: string | null
          analysed_by?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id?: string
          completed_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string
          file_name?: string
          file_sha256?: string
          headers?: Json
          id?: string
          mapping?: Json | null
          row_count?: number
          source_system?: string
          status?: Database["public"]["Enums"]["lab_import_status"]
          summary?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_import_batches_analysed_by_fkey"
            columns: ["analysed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_batches_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_batches_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_batches_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_import_rows: {
        Row: {
          accession: string | null
          attempts: number
          batch_id: string
          candidate_patient_ids: string[]
          clinic_id: string
          created_at: string
          errors: string[]
          group_key: string | null
          id: string
          lab_result_id: string | null
          match_confirmed_by: string | null
          match_kind: string | null
          parameter_id: string | null
          patient_id: string | null
          patient_key: string | null
          performed_at: string | null
          raw: Json
          row_number: number
          status: Database["public"]["Enums"]["lab_import_row_status"]
          test_id: string | null
          updated_at: string
          value_boolean: boolean | null
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          accession?: string | null
          attempts?: number
          batch_id: string
          candidate_patient_ids?: string[]
          clinic_id: string
          created_at?: string
          errors?: string[]
          group_key?: string | null
          id?: string
          lab_result_id?: string | null
          match_confirmed_by?: string | null
          match_kind?: string | null
          parameter_id?: string | null
          patient_id?: string | null
          patient_key?: string | null
          performed_at?: string | null
          raw: Json
          row_number: number
          status?: Database["public"]["Enums"]["lab_import_row_status"]
          test_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          accession?: string | null
          attempts?: number
          batch_id?: string
          candidate_patient_ids?: string[]
          clinic_id?: string
          created_at?: string
          errors?: string[]
          group_key?: string | null
          id?: string
          lab_result_id?: string | null
          match_confirmed_by?: string | null
          match_kind?: string | null
          parameter_id?: string | null
          patient_id?: string | null
          patient_key?: string | null
          performed_at?: string | null
          raw?: Json
          row_number?: number
          status?: Database["public"]["Enums"]["lab_import_row_status"]
          test_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lab_import_rows_batch_fkey"
            columns: ["batch_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_import_batches"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_import_rows_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_rows_match_confirmed_by_fkey"
            columns: ["match_confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_import_rows_parameter_fkey"
            columns: ["parameter_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_test_parameters"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_import_rows_patient_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_import_rows_result_fkey"
            columns: ["lab_result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_import_rows_test_fkey"
            columns: ["test_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_tests"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_order_items: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          list_price_snapshot: number
          order_id: string
          panel_id: string | null
          patient_id: string
          price_snapshot: number
          status: Database["public"]["Enums"]["lab_item_status"]
          status_changed_at: string
          status_changed_by: string | null
          test_code_snapshot: string
          test_id: string
          test_name_snapshot: string
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          list_price_snapshot: number
          order_id: string
          panel_id?: string | null
          patient_id: string
          price_snapshot: number
          status?: Database["public"]["Enums"]["lab_item_status"]
          status_changed_at?: string
          status_changed_by?: string | null
          test_code_snapshot: string
          test_id: string
          test_name_snapshot: string
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          list_price_snapshot?: number
          order_id?: string
          panel_id?: string | null
          patient_id?: string
          price_snapshot?: number
          status?: Database["public"]["Enums"]["lab_item_status"]
          status_changed_at?: string
          status_changed_by?: string | null
          test_code_snapshot?: string
          test_id?: string
          test_name_snapshot?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_order_items_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_order_items_order_fkey"
            columns: ["order_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "clinic_id", "patient_id"]
          },
          {
            foreignKeyName: "lab_order_items_panel_fkey"
            columns: ["panel_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_panels"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_order_items_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_order_items_test_fkey"
            columns: ["test_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_tests"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_orders: {
        Row: {
          appointment_id: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          clinic_id: string
          created_at: string
          creation_key: string | null
          external_reference: string | null
          id: string
          ordered_by: string
          ordering_doctor_id: string | null
          patient_id: string
          source: Database["public"]["Enums"]["lab_order_source"]
          status: Database["public"]["Enums"]["lab_order_status"]
          updated_at: string
        }
        Insert: {
          appointment_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id: string
          created_at?: string
          creation_key?: string | null
          external_reference?: string | null
          id?: string
          ordered_by: string
          ordering_doctor_id?: string | null
          patient_id: string
          source: Database["public"]["Enums"]["lab_order_source"]
          status?: Database["public"]["Enums"]["lab_order_status"]
          updated_at?: string
        }
        Update: {
          appointment_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id?: string
          created_at?: string
          creation_key?: string | null
          external_reference?: string | null
          id?: string
          ordered_by?: string
          ordering_doctor_id?: string | null
          patient_id?: string
          source?: Database["public"]["Enums"]["lab_order_source"]
          status?: Database["public"]["Enums"]["lab_order_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_orders_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_orders_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_orders_consultation_fkey"
            columns: ["appointment_id", "clinic_id", "patient_id", "ordering_doctor_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id", "patient_id", "doctor_id"]
          },
          {
            foreignKeyName: "lab_orders_ordered_by_fkey"
            columns: ["ordered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_orders_ordering_doctor_fkey"
            columns: ["ordering_doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_orders_patient_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_panel_tests: {
        Row: {
          clinic_id: string
          created_at: string
          panel_id: string
          sort_order: number
          test_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          panel_id: string
          sort_order?: number
          test_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          panel_id?: string
          sort_order?: number
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_panel_tests_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_panel_tests_panel_fkey"
            columns: ["panel_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_panels"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_panel_tests_test_fkey"
            columns: ["test_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_tests"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_panels: {
        Row: {
          active: boolean
          clinic_id: string
          code: string
          created_at: string
          id: string
          name: string
          price: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          clinic_id: string
          code: string
          created_at?: string
          id?: string
          name: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          clinic_id?: string
          code?: string
          created_at?: string
          id?: string
          name?: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_panels_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_reference_ranges: {
        Row: {
          active: boolean
          age_max_days: number | null
          age_min_days: number | null
          clinic_id: string
          created_at: string
          critical_high: number | null
          critical_low: number | null
          high: number | null
          id: string
          low: number | null
          method_label: string | null
          normal_text: string | null
          parameter_id: string
          sex: Database["public"]["Enums"]["patient_sex"] | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          age_max_days?: number | null
          age_min_days?: number | null
          clinic_id: string
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          high?: number | null
          id?: string
          low?: number | null
          method_label?: string | null
          normal_text?: string | null
          parameter_id: string
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          age_max_days?: number | null
          age_min_days?: number | null
          clinic_id?: string
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          high?: number | null
          id?: string
          low?: number | null
          method_label?: string | null
          normal_text?: string | null
          parameter_id?: string
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_reference_ranges_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_reference_ranges_parameter_fkey"
            columns: ["parameter_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_test_parameters"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_result_values: {
        Row: {
          clinic_id: string
          created_at: string
          critical_high: number | null
          critical_low: number | null
          flag: Database["public"]["Enums"]["lab_value_flag"]
          id: string
          parameter_id: string
          range_high: number | null
          range_low: number | null
          range_text: string | null
          reference_range_id: string | null
          result_id: string
          unit_snapshot: string | null
          updated_at: string
          value_boolean: boolean | null
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          flag?: Database["public"]["Enums"]["lab_value_flag"]
          id?: string
          parameter_id: string
          range_high?: number | null
          range_low?: number | null
          range_text?: string | null
          reference_range_id?: string | null
          result_id: string
          unit_snapshot?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          flag?: Database["public"]["Enums"]["lab_value_flag"]
          id?: string
          parameter_id?: string
          range_high?: number | null
          range_low?: number | null
          range_text?: string | null
          reference_range_id?: string | null
          result_id?: string
          unit_snapshot?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lab_result_values_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_result_values_parameter_fkey"
            columns: ["parameter_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_test_parameters"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_result_values_range_fkey"
            columns: ["reference_range_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_reference_ranges"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_result_values_result_fkey"
            columns: ["result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_results: {
        Row: {
          clinic_id: string
          correction_reason: string | null
          created_at: string
          entered_at: string
          entered_by: string
          id: string
          lab_comment: string | null
          order_item_id: string
          patient_id: string
          performed_at: string | null
          source: Database["public"]["Enums"]["lab_result_source"]
          status: Database["public"]["Enums"]["lab_result_status"]
          submitted_at: string | null
          submitted_by: string | null
          supersedes_result_id: string | null
          updated_at: string
          verified_at: string | null
          verified_by: string | null
          version: number
        }
        Insert: {
          clinic_id: string
          correction_reason?: string | null
          created_at?: string
          entered_at?: string
          entered_by: string
          id?: string
          lab_comment?: string | null
          order_item_id: string
          patient_id: string
          performed_at?: string | null
          source?: Database["public"]["Enums"]["lab_result_source"]
          status?: Database["public"]["Enums"]["lab_result_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          supersedes_result_id?: string | null
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Update: {
          clinic_id?: string
          correction_reason?: string | null
          created_at?: string
          entered_at?: string
          entered_by?: string
          id?: string
          lab_comment?: string | null
          order_item_id?: string
          patient_id?: string
          performed_at?: string | null
          source?: Database["public"]["Enums"]["lab_result_source"]
          status?: Database["public"]["Enums"]["lab_result_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          supersedes_result_id?: string | null
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "lab_results_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_item_fkey"
            columns: ["order_item_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_order_items"
            referencedColumns: ["id", "clinic_id", "patient_id"]
          },
          {
            foreignKeyName: "lab_results_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_supersedes_fkey"
            columns: ["supersedes_result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_results_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_sample_items: {
        Row: {
          clinic_id: string
          created_at: string
          order_item_id: string
          sample_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          order_item_id: string
          sample_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          order_item_id?: string
          sample_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_sample_items_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_sample_items_item_fkey"
            columns: ["order_item_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_order_items"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_sample_items_sample_fkey"
            columns: ["sample_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_samples"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_samples: {
        Row: {
          clinic_id: string
          collected_at: string
          collected_by: string
          created_at: string
          creation_key: string | null
          id: string
          notes: string | null
          order_id: string
          patient_id: string
          received_at: string | null
          received_by: string | null
          reject_reason: string | null
          rejected_at: string | null
          rejected_by: string | null
          sample_code: string
          sample_type: string
          status: Database["public"]["Enums"]["lab_sample_status"]
          updated_at: string
        }
        Insert: {
          clinic_id: string
          collected_at?: string
          collected_by: string
          created_at?: string
          creation_key?: string | null
          id?: string
          notes?: string | null
          order_id: string
          patient_id: string
          received_at?: string | null
          received_by?: string | null
          reject_reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          sample_code: string
          sample_type: string
          status?: Database["public"]["Enums"]["lab_sample_status"]
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          collected_at?: string
          collected_by?: string
          created_at?: string
          creation_key?: string | null
          id?: string
          notes?: string | null
          order_id?: string
          patient_id?: string
          received_at?: string | null
          received_by?: string | null
          reject_reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          sample_code?: string
          sample_type?: string
          status?: Database["public"]["Enums"]["lab_sample_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_samples_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_samples_collected_by_fkey"
            columns: ["collected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_samples_order_fkey"
            columns: ["order_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "clinic_id", "patient_id"]
          },
          {
            foreignKeyName: "lab_samples_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_samples_rejected_by_fkey"
            columns: ["rejected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_test_categories: {
        Row: {
          active: boolean
          clinic_id: string
          created_at: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          clinic_id: string
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          clinic_id?: string
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_test_categories_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_test_parameters: {
        Row: {
          active: boolean
          choices: string[] | null
          clinic_id: string
          code: string
          created_at: string
          decimals: number | null
          id: string
          name: string
          sort_order: number
          test_id: string
          unit: string | null
          updated_at: string
          value_type: Database["public"]["Enums"]["lab_value_type"]
        }
        Insert: {
          active?: boolean
          choices?: string[] | null
          clinic_id: string
          code: string
          created_at?: string
          decimals?: number | null
          id?: string
          name: string
          sort_order?: number
          test_id: string
          unit?: string | null
          updated_at?: string
          value_type: Database["public"]["Enums"]["lab_value_type"]
        }
        Update: {
          active?: boolean
          choices?: string[] | null
          clinic_id?: string
          code?: string
          created_at?: string
          decimals?: number | null
          id?: string
          name?: string
          sort_order?: number
          test_id?: string
          unit?: string | null
          updated_at?: string
          value_type?: Database["public"]["Enums"]["lab_value_type"]
        }
        Relationships: [
          {
            foreignKeyName: "lab_test_parameters_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_test_parameters_test_fkey"
            columns: ["test_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_tests"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      lab_tests: {
        Row: {
          active: boolean
          category_id: string | null
          clinic_id: string
          code: string
          created_at: string
          id: string
          name: string
          preparation_text: string | null
          price: number
          sample_type: string
          sort_order: number
          turnaround_hours: number | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          category_id?: string | null
          clinic_id: string
          code: string
          created_at?: string
          id?: string
          name: string
          preparation_text?: string | null
          price?: number
          sample_type: string
          sort_order?: number
          turnaround_hours?: number | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          category_id?: string | null
          clinic_id?: string
          code?: string
          created_at?: string
          id?: string
          name?: string
          preparation_text?: string | null
          price?: number
          sample_type?: string
          sort_order?: number
          turnaround_hours?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_tests_category_fkey"
            columns: ["category_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_test_categories"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "lab_tests_clinic_id_fkey"
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
            columns: ["conversation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "messages_voice_message_id_fkey"
            columns: ["voice_message_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "voice_messages"
            referencedColumns: ["id", "clinic_id"]
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
          lab_result_id: string | null
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
          lab_result_id?: string | null
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
          lab_result_id?: string | null
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
            columns: ["appointment_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id"]
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
            columns: ["conversation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "notification_jobs_lab_result_fkey"
            columns: ["lab_result_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "lab_results"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      patient_merges: {
        Row: {
          canonical_patient_id: string
          clinic_id: string
          copied: Json
          duplicate_patient_id: string
          id: string
          merged_at: string
          merged_by: string
          moved: Json
          preview: Json
          reason: string
          unmerge_reason: string | null
          unmerge_report: Json | null
          unmerged_at: string | null
          unmerged_by: string | null
        }
        Insert: {
          canonical_patient_id: string
          clinic_id: string
          copied?: Json
          duplicate_patient_id: string
          id?: string
          merged_at?: string
          merged_by: string
          moved?: Json
          preview: Json
          reason: string
          unmerge_reason?: string | null
          unmerge_report?: Json | null
          unmerged_at?: string | null
          unmerged_by?: string | null
        }
        Update: {
          canonical_patient_id?: string
          clinic_id?: string
          copied?: Json
          duplicate_patient_id?: string
          id?: string
          merged_at?: string
          merged_by?: string
          moved?: Json
          preview?: Json
          reason?: string
          unmerge_reason?: string | null
          unmerge_report?: Json | null
          unmerged_at?: string | null
          unmerged_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_merges_canonical_fkey"
            columns: ["canonical_patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "patient_merges_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_merges_duplicate_fkey"
            columns: ["duplicate_patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "patient_merges_merged_by_fkey"
            columns: ["merged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_merges_unmerged_by_fkey"
            columns: ["unmerged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          date_of_birth: string | null
          document_number: string | null
          full_name: string | null
          id: string
          last_seen_at: string | null
          merged_at: string | null
          merged_into_patient_id: string | null
          operational_notes: string | null
          phone: string | null
          pinfl: string | null
          preferred_language: string
          sex: Database["public"]["Enums"]["patient_sex"] | null
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
          date_of_birth?: string | null
          document_number?: string | null
          full_name?: string | null
          id?: string
          last_seen_at?: string | null
          merged_at?: string | null
          merged_into_patient_id?: string | null
          operational_notes?: string | null
          phone?: string | null
          pinfl?: string | null
          preferred_language?: string
          sex?: Database["public"]["Enums"]["patient_sex"] | null
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
          date_of_birth?: string | null
          document_number?: string | null
          full_name?: string | null
          id?: string
          last_seen_at?: string | null
          merged_at?: string | null
          merged_into_patient_id?: string | null
          operational_notes?: string | null
          phone?: string | null
          pinfl?: string | null
          preferred_language?: string
          sex?: Database["public"]["Enums"]["patient_sex"] | null
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
          {
            foreignKeyName: "patients_merged_into_fkey"
            columns: ["merged_into_patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          appointment_id: string | null
          clinic_id: string
          created_at: string
          currency: string
          id: string
          lab_order_id: string | null
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
          appointment_id?: string | null
          clinic_id: string
          created_at?: string
          currency?: string
          id?: string
          lab_order_id?: string | null
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
          appointment_id?: string | null
          clinic_id?: string
          created_at?: string
          currency?: string
          id?: string
          lab_order_id?: string | null
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
            columns: ["appointment_id", "clinic_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "payments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_lab_order_fkey"
            columns: ["lab_order_id", "clinic_id", "patient_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "clinic_id", "patient_id"]
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
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
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
      rate_limit_buckets: {
        Row: {
          hits: number
          key: string
          window_started_at: string
        }
        Insert: {
          hits: number
          key: string
          window_started_at: string
        }
        Update: {
          hits?: number
          key?: string
          window_started_at?: string
        }
        Relationships: []
      }
      referrals: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          clinic_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          creation_key: string | null
          declined_at: string | null
          declined_by: string | null
          declined_reason: string | null
          expires_at: string
          follow_up_appointment_id: string | null
          handoff_note: string | null
          id: string
          originating_appointment_id: string
          patient_id: string
          priority: Database["public"]["Enums"]["referral_priority"]
          reason: string
          referred_to_doctor_id: string
          referring_doctor_id: string
          revoked_at: string | null
          revoked_by: string | null
          revoked_reason: string | null
          started_at: string | null
          started_by: string | null
          status: Database["public"]["Enums"]["referral_status"]
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          clinic_id: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by: string
          creation_key?: string | null
          declined_at?: string | null
          declined_by?: string | null
          declined_reason?: string | null
          expires_at?: string
          follow_up_appointment_id?: string | null
          handoff_note?: string | null
          id?: string
          originating_appointment_id: string
          patient_id: string
          priority?: Database["public"]["Enums"]["referral_priority"]
          reason: string
          referred_to_doctor_id: string
          referring_doctor_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          started_at?: string | null
          started_by?: string | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          clinic_id?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          creation_key?: string | null
          declined_at?: string | null
          declined_by?: string | null
          declined_reason?: string | null
          expires_at?: string
          follow_up_appointment_id?: string | null
          handoff_note?: string | null
          id?: string
          originating_appointment_id?: string
          patient_id?: string
          priority?: Database["public"]["Enums"]["referral_priority"]
          reason?: string
          referred_to_doctor_id?: string
          referring_doctor_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          revoked_reason?: string | null
          started_at?: string | null
          started_by?: string | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "referrals_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_declined_by_fkey"
            columns: ["declined_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_follow_up_appointment_fkey"
            columns: [
              "follow_up_appointment_id",
              "clinic_id",
              "patient_id",
              "referred_to_doctor_id",
            ]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id", "patient_id", "doctor_id"]
          },
          {
            foreignKeyName: "referrals_originating_appointment_fkey"
            columns: [
              "originating_appointment_id",
              "clinic_id",
              "patient_id",
              "referring_doctor_id",
            ]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id", "patient_id", "doctor_id"]
          },
          {
            foreignKeyName: "referrals_patient_same_clinic_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "referrals_referred_to_doctor_same_clinic_fkey"
            columns: ["referred_to_doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "referrals_referring_doctor_same_clinic_fkey"
            columns: ["referring_doctor_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "referrals_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_started_by_fkey"
            columns: ["started_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            columns: ["specialty_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id", "clinic_id"]
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
          purged_at: string | null
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
          purged_at?: string | null
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
          purged_at?: string | null
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
            columns: ["conversation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "clinic_id"]
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
          p_idempotency_key?: string
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
          lab_result_id: string | null
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
      collect_lab_sample: {
        Args: {
          p_clinic_id: string
          p_collected_by: string
          p_creation_key?: string
          p_item_ids: string[]
          p_notes?: string
          p_order_id: string
        }
        Returns: {
          lab_sample_id: string
          replayed: boolean
          sample_code: string
        }[]
      }
      current_doctor_id: { Args: { p_clinic_id: string }; Returns: string }
      consume_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: Json
      }
      create_lab_order: {
        Args: {
          p_appointment_id?: string
          p_clinic_id: string
          p_creation_key?: string
          p_ordered_by: string
          p_ordering_doctor_id?: string
          p_panel_ids: string[]
          p_patient_id: string
          p_source: Database["public"]["Enums"]["lab_order_source"]
          p_test_ids: string[]
        }
        Returns: {
          lab_order_id: string
          replayed: boolean
        }[]
      }
      discard_lab_result_draft: {
        Args: { p_by: string; p_clinic_id: string; p_result_id: string }
        Returns: boolean
      }
      doctor_can_read_appointment: {
        Args: {
          p_appointment_id: string
          p_clinic_id: string
          p_doctor_id: string
          p_patient_id: string
        }
        Returns: boolean
      }
      doctor_can_read_patient: {
        Args: { p_clinic_id: string; p_patient_id: string }
        Returns: boolean
      }
      doctor_patient_access: {
        Args: { p_doctor_id: string; p_patient_id: string }
        Returns: {
          active_referral_ids: string[]
          clinic_id: string
          history_doctor_ids: string[]
          own_patient: boolean
          referral_appointment_ids: string[]
        }[]
      }
      expire_due_referrals: {
        Args: { p_clinic_id?: string }
        Returns: number
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
      is_linked_doctor: { Args: { p_doctor_id: string }; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      lab_entry_ranges: {
        Args: { p_clinic_id: string; p_order_item_id: string }
        Returns: {
          critical_high: number
          critical_low: number
          parameter_id: string
          range_high: number
          range_low: number
          range_text: string
        }[]
      }
      lab_release_to_patient: { Args: { p_clinic_id: string }; Returns: boolean }
      receive_lab_sample: {
        Args: {
          p_clinic_id: string
          p_received_by: string
          p_sample_id: string
        }
        Returns: boolean
      }
      claim_external_lab_requests: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: Database["public"]["Tables"]["lab_external_requests"]["Row"][]
      }
      merge_patients: {
        Args: {
          p_actor: string
          p_canonical_id: string
          p_clinic_id: string
          p_duplicate_id: string
          p_fingerprint: string
          p_reason: string
        }
        Returns: string
      }
      patient_canonical_id: { Args: { p_patient_id: string }; Returns: string }
      patient_duplicate_candidates: {
        Args: { p_clinic_id: string; p_limit?: number }
        Returns: { patient_a: string; patient_b: string; reasons: string[] }[]
      }
      patient_entity_counts: { Args: { p_clinic_id: string; p_patient_id: string }; Returns: Json }
      patient_merge_preview: {
        Args: { p_canonical_id: string; p_clinic_id: string; p_duplicate_id: string }
        Returns: Json
      }
      patient_record_group: { Args: { p_patient_id: string }; Returns: string[] }
      record_external_lab_result: {
        Args: {
          p_clinic_id: string
          p_external_result_id: string
          p_performed_at?: string
          p_request_id: string
          p_values: Json
        }
        Returns: { lab_result_id: string; replayed: boolean; submitted: boolean }[]
      }
      request_external_lab: {
        Args: { p_actor: string; p_clinic_id: string; p_order_item_id: string; p_provider_id: string }
        Returns: { lab_external_request_id: string; replayed: boolean }[]
      }
      reject_lab_sample: {
        Args: {
          p_clinic_id: string
          p_reason: string
          p_rejected_by: string
          p_sample_id: string
        }
        Returns: boolean
      }
      release_webhook_update: {
        Args: { p_external_id: string; p_source: string }
        Returns: undefined
      }
      return_lab_result: {
        Args: { p_by: string; p_clinic_id: string; p_result_id: string }
        Returns: boolean
      }
      reschedule_appointment: {
        Args: {
          p_actor?: string
          p_appointment_id: string
          p_clinic_id: string
          p_new_start_at: string
        }
        Returns: Record<string, unknown>
      }
      run_lab_import: {
        Args: {
          p_actor: string
          p_after_row?: number
          p_batch_id: string
          p_clinic_id: string
          p_dry_run: boolean
          p_max_groups?: number
        }
        Returns: {
          error_code: string
          first_row: number
          group_key: string
          lab_result_id: string
          outcome: string
        }[]
      }
      save_lab_result_draft: {
        Args: {
          p_clinic_id: string
          p_entered_by: string
          p_lab_comment?: string
          p_order_item_id: string
          p_performed_at?: string
          p_values: Json
        }
        Returns: {
          created: boolean
          lab_result_id: string
        }[]
      }
      start_consultation: {
        Args: {
          p_actor: string
          p_appointment_id: string
          p_clinic_id: string
          p_doctor_id?: string
          p_from_status: Database["public"]["Enums"]["appointment_status"]
          p_link_referral?: boolean
          p_via: string
        }
        Returns: Json
      }
      start_lab_result_correction: {
        Args: {
          p_by: string
          p_clinic_id: string
          p_reason: string
          p_result_id: string
        }
        Returns: {
          created: boolean
          lab_result_id: string
        }[]
      }
      start_walk_in_consultation: {
        Args: {
          p_actor: string
          p_clinic_id: string
          p_doctor_id: string
          p_patient_id: string
          p_service_id: string
          p_start_at: string
        }
        Returns: Json
      }
      store_lab_import_analysis: {
        Args: {
          p_actor: string
          p_batch_id: string
          p_clinic_id: string
          p_mapping: Json
          p_rows: Json
          p_summary: Json
        }
        Returns: undefined
      }
      submit_lab_result: {
        Args: { p_clinic_id: string; p_result_id: string; p_submitted_by: string }
        Returns: boolean
      }
      unmerge_patients: {
        Args: { p_actor: string; p_clinic_id: string; p_merge_id: string; p_reason: string }
        Returns: Json
      }
      verify_lab_result: {
        Args: { p_clinic_id: string; p_result_id: string; p_verified_by: string }
        Returns: boolean
      }
    }
    Enums: {
      actor_type: "staff" | "system" | "patient" | "telegram"
      clinical_record_type:
        | "consultation_note"
        | "assessment"
        | "diagnosis"
        | "prescription"
        | "lab_order"
        | "lab_result"
        | "medical_history"
        | "follow_up"
      appointment_source:
        | "telegram_mini_app"
        | "telegram_chat"
        | "web"
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
      conversation_status: "open" | "assigned" | "closed"
      lab_document_kind: "report" | "scan" | "image" | "import_source"
      lab_external_status:
        | "queued"
        | "sent"
        | "in_progress"
        | "resulted"
        | "failed"
        | "rejected"
        | "cancelled"
      lab_import_row_status:
        | "pending"
        | "ready"
        | "invalid"
        | "unmatched"
        | "possible_match"
        | "conflict"
        | "duplicate"
        | "imported"
        | "failed"
        | "skipped"
      lab_import_status:
        | "uploaded"
        | "analysed"
        | "confirmed"
        | "completed"
        | "cancelled"
      lab_item_status:
        | "ordered"
        | "ready_for_collection"
        | "collected"
        | "processing"
        | "resulted"
        | "verified"
        | "cancelled"
      lab_order_source: "consultation" | "walk_in" | "external_import"
      lab_order_status: "active" | "completed" | "cancelled"
      lab_result_source: "manual" | "import" | "external"
      lab_result_status: "draft" | "submitted" | "verified" | "superseded"
      lab_sample_status: "collected" | "received" | "rejected"
      lab_value_flag:
        | "normal"
        | "low"
        | "high"
        | "critical_low"
        | "critical_high"
        | "abnormal"
        | "not_evaluated"
      lab_value_type: "numeric" | "text" | "boolean" | "choice"
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
        | "lab_result_ready"
      patient_sex: "female" | "male"
      payment_provider: "manual" | "click" | "payme" | "cash" | "card_terminal"
      payment_status:
        | "unpaid"
        | "pending"
        | "paid"
        | "failed"
        | "refunded"
        | "manual_review"
      referral_priority: "routine" | "urgent"
      referral_status:
        | "pending"
        | "accepted"
        | "in_progress"
        | "declined"
        | "completed"
        | "revoked"
        | "expired"
      staff_role:
        | "owner"
        | "manager"
        | "admin"
        | "receptionist"
        | "lab"
        | "doctor"
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
      clinical_record_type: [
        "consultation_note",
        "assessment",
        "diagnosis",
        "prescription",
        "lab_order",
        "lab_result",
        "medical_history",
        "follow_up",
      ],
      appointment_source: [
        "telegram_mini_app",
        "telegram_chat",
        "web",
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
      conversation_status: ["open", "assigned", "closed"],
      lab_document_kind: ["report", "scan", "image", "import_source"],
      lab_external_status: [
        "queued",
        "sent",
        "in_progress",
        "resulted",
        "failed",
        "rejected",
        "cancelled",
      ],
      lab_import_row_status: [
        "pending",
        "ready",
        "invalid",
        "unmatched",
        "possible_match",
        "conflict",
        "duplicate",
        "imported",
        "failed",
        "skipped",
      ],
      lab_import_status: [
        "uploaded",
        "analysed",
        "confirmed",
        "completed",
        "cancelled",
      ],
      lab_item_status: [
        "ordered",
        "ready_for_collection",
        "collected",
        "processing",
        "resulted",
        "verified",
        "cancelled",
      ],
      lab_order_source: ["consultation", "walk_in", "external_import"],
      lab_order_status: ["active", "completed", "cancelled"],
      lab_result_source: ["manual", "import", "external"],
      lab_result_status: ["draft", "submitted", "verified", "superseded"],
      lab_sample_status: ["collected", "received", "rejected"],
      lab_value_flag: [
        "normal",
        "low",
        "high",
        "critical_low",
        "critical_high",
        "abnormal",
        "not_evaluated",
      ],
      lab_value_type: ["numeric", "text", "boolean", "choice"],
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
        "lab_result_ready",
      ],
      patient_sex: ["female", "male"],
      payment_provider: ["manual", "click", "payme", "cash", "card_terminal"],
      payment_status: [
        "unpaid",
        "pending",
        "paid",
        "failed",
        "refunded",
        "manual_review",
      ],
      referral_priority: ["routine", "urgent"],
      referral_status: [
        "pending",
        "accepted",
        "in_progress",
        "declined",
        "completed",
        "revoked",
        "expired",
      ],
      staff_role: [
        "owner",
        "manager",
        "admin",
        "receptionist",
        "lab",
        "doctor",
      ],
      telegram_bot_status: ["disabled", "active", "error"],
      time_block_reason: ["break", "absence", "reservation", "admin_hold"],
      voice_status: ["none", "pending", "transcribed", "failed"],
    },
  },
} as const

