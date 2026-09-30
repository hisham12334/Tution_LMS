import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Supabase previously documented this browser-safe credential as the anon key.
// Accept both names so existing local setups keep working during the rename.
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const configured = Boolean(supabaseUrl && publishableKey && !supabaseUrl.includes('YOUR_PROJECT'));
export const supabase = configured ? createClient(supabaseUrl!, publishableKey!, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
}) : null;
