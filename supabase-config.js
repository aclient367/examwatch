const EXAMWATCH_SUPABASE_URL = "https://banvehsediuqdbkfispr.supabase.co";
const EXAMWATCH_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_JFSVeGq5fTnYwNarxNX1Cw_PEahBLqj";

if (!window.supabase || typeof window.supabase.createClient !== "function") {
  throw new Error("Supabase SDK failed to load. Check the internet connection and reload.");
}

window.examwatchSupabase = window.supabase.createClient(
  EXAMWATCH_SUPABASE_URL,
  EXAMWATCH_SUPABASE_PUBLISHABLE_KEY
);
