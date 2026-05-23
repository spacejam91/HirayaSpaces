(function () {
  const cfg = window.HIRAYA_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY
      || cfg.SUPABASE_URL.startsWith('https://YOUR-')
      || cfg.SUPABASE_PUBLISHABLE_KEY.startsWith('YOUR-')) {
    console.warn('[Hiraya] /js/config.js is missing or still has placeholder values. Auth will not work until you fill it in.');
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[Hiraya] Supabase JS SDK failed to load. Check the CDN <script> tag.');
    return;
  }

  window.hirayaSupabase = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'implicit'
      }
    }
  );
})();
