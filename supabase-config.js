/* Tiny Artist — Supabase connection, Step 1 (read-only kill switch).
 *
 * This file is the ONLY place the browser-side Supabase connection lives.
 * The static storefront has no build step, so Vercel environment variables
 * cannot reach the browser automatically — that is why the project URL +
 * publishable key live here instead of in .env. The publishable key is
 * designed to be public: Supabase Row Level Security (see
 * backend/supabase/schema.sql) decides what it may read, and here it may
 * only READ the public site_settings flag (deactivated true/false).
 *
 * NEVER put the secret key (sb_secret_...) in this file, in any frontend
 * file, or in the repository. The secret key belongs ONLY in Vercel
 * project settings as SUPABASE_SERVICE_ROLE_KEY, for server code only
 * (see .env.example). If a secret key ever lands in this repo, rotate it
 * in the Supabase dashboard immediately.
 *
 * The project URL below is set: Tooba's Supabase project
 * (agcqfmbcnjquritvftha), switched to on 2026-11-16 after the earlier
 * project proved inaccessible to the owner's account (see
 * SUPABASE-CONNECT.md). The schema is applied there, so reads return the
 * live site_settings flag; if a read fails the site falls back to
 * site-status.json, as designed.
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://agcqfmbcnjquritvftha.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_tnw7tJZya7ez403_jGW8Dg_sQl3XMMx";

  var configured =
    typeof SUPABASE_URL === "string" &&
    SUPABASE_URL.indexOf("https://") === 0 &&
    SUPABASE_URL.indexOf("YOUR-PROJECT-REF") === -1 &&
    typeof SUPABASE_PUBLISHABLE_KEY === "string" &&
    SUPABASE_PUBLISHABLE_KEY.length > 0;

  function trimSlash(u) {
    return String(u).replace(/\/+$/, "");
  }

  /* Returns true/false from site_settings, or null when anything is
     unknown (not configured, no fetch, timeout, bad response). Callers
     must fall back to site-status.json / the local flag on null.
     This function never throws. */
  async function fetchDeactivated(timeoutMs) {
    if (!configured || typeof fetch !== "function") return null;
    var controller = null;
    var timer = null;
    try {
      var options = {
        cache: "no-store",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: "Bearer " + SUPABASE_PUBLISHABLE_KEY,
          Accept: "application/json"
        }
      };
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        options.signal = controller.signal;
        timer = setTimeout(function () {
          try { controller.abort(); } catch (e) {}
        }, timeoutMs || 3000);
      }
      var r = await fetch(
        trimSlash(SUPABASE_URL) + "/rest/v1/site_settings?select=deactivated&id=eq.1",
        options
      );
      if (!r.ok) return null;
      var rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].deactivated === "boolean") {
        return rows[0].deactivated;
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  window.TINY_ARTIST_SUPABASE = {
    url: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    configured: configured,
    fetchDeactivated: fetchDeactivated
  };
})();
