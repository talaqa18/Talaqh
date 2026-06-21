// ============================================================================
// Talaqa ↔ Supabase bridge  (loaded as an external ES module)
// ----------------------------------------------------------------------------
// WHY EXTERNAL: the offline single-file app must keep working with no backend,
// and the Node test harness (tools/*.cjs) only executes the INLINE <script>.
// Keeping all Supabase code here means:
//   • no backend configured  -> window.TalaqaBackend.enabled === false, and every
//     inline hook falls back to the original local/simulated behavior;
//   • the Node harness never imports this file, so its tests stay green.
//
// supabase-js is imported LAZILY (dynamic import) and ONLY when a backend is
// configured — the offline demo never touches the network.
//
// SECURITY: only the publishable anon key is used here (RLS-protected). All
// trusted writes (XP, progress, grades) go through SECURITY DEFINER RPCs; AI keys
// stay server-side in Edge Functions. This module never holds a secret key.
// ============================================================================

const cfg = (typeof window !== "undefined" && window.__TALAQA_CONFIG__) || {};
const SB_URL = cfg.supabaseUrl || "";
const SB_ANON = cfg.supabaseAnonKey || "";
const enabled = !!(SB_URL && SB_ANON);

// Default network timeouts (ms). The network is required for AI; without a cap a
// flaky connection would hang the UI in "recording"/"thinking" forever.
const T_AI = 20000;   // tutor / pronounce / STT (LLM + Whisper round-trips)
const T_TTS = 12000;  // text-to-speech
const T_DB = 8000;    // profile / progress reads at boot

let _client = null;
let _clientPromise = null;
async function ensureClient() {
  if (!enabled) return null;
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = (async () => {
      // Prefer the self-hosted UMD bundle (window.supabase) — no third-party CDN
      // dependency. Wait briefly for the deferred <script> to finish, then fall
      // back to esm.sh only if it never loaded.
      let createClient = null;
      for (let i = 0; i < 40; i++) {
        if (typeof window !== "undefined" && window.supabase && window.supabase.createClient) { createClient = window.supabase.createClient; break; }
        await new Promise((r) => setTimeout(r, 50)); // up to ~2s
      }
      // Web only: if the self-hosted bundle never loaded, fall back to the CDN. The
      // NATIVE app must NEVER fetch+execute remote code (App Review rejects it and it
      // would break login offline) — it relies solely on the bundled vendor/supabase.js.
      const _native = (typeof window !== "undefined" && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (!createClient && !_native) {
        try { ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2")); } catch (_) { /* offline */ }
      }
      if (!createClient) throw new Error("failed to fetch supabase library");
      _client = createClient(SB_URL, SB_ANON, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
      });
      return _client;
    })();
  }
  return _clientPromise;
}

// Race a promise against a timeout. On timeout the rejection carries isTimeout so
// friendlyError() can show a clear "connection dropped" message.
function withTimeout(promise, ms, label) {
  let to;
  const timer = new Promise((_, reject) => {
    to = setTimeout(() => {
      const e = new Error((label || "request") + " timed out");
      e.isTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(to));
}

// SHA-256 hex of a string — must match the tts function's clipKey() so the client
// can fetch a pre-generated clip straight from the public CDN.
async function _clipKey(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Map a Supabase unit_progress row -> Talaqa's sequential sections model
// ('done' | 'current' | 'locked'). The first not-done section becomes current.
function sectionsFromUnitProgress(up) {
  const order = ["words", "listening", "reading", "conversation", "grammar"];
  const done = up
    ? {
        words: up.words_completed,
        listening: up.listening_completed,
        reading: up.reading_completed,
        conversation: up.conversation_completed,
        grammar: up.grammar_completed,
      }
    : {};
  const out = {};
  let currentSet = false;
  for (const k of order) {
    if (done[k]) out[k] = "done";
    else if (!currentSet) { out[k] = "current"; currentSet = true; }
    else out[k] = "locked";
  }
  return out;
}

const TB = {
  enabled,
  ready: false,
  leaderboardCache: null,
  _user: null,
  get client() { return _client; },

  // Invoke an Edge Function with a timeout; copy the HTTP status onto the error
  // (FunctionsHttpError hides it in .context) so friendlyError can map 429/5xx.
  async _invoke(name, opts, ms = T_AI) {
    const sb = await ensureClient();
    const { data, error } = await withTimeout(sb.functions.invoke(name, opts), ms, name);
    if (error) {
      try { if (error.context && typeof error.context.status === "number") error.status = error.status || error.context.status; } catch (_) {}
      throw error;
    }
    return data;
  },

  /** Restore an existing session at boot. Returns {authed,user} or null. */
  async init() {
    if (!enabled) { this.ready = true; return null; }
    // Persistent login: the session lives in localStorage and auto-refreshes, so a
    // signed-in user stays signed in across app restarts. We let TRANSIENT errors
    // (library load / getSession timeout) PROPAGATE so the boot router keeps a
    // previously-signed-in user on Home instead of bouncing them to the login
    // screen on a flaky network. Only a clean "no session" returns null -> sign in.
    const sb = await ensureClient();
    const { data: { session } } = await withTimeout(sb.auth.getSession(), T_DB, "session");
    this.ready = true;
    if (session && session.user) { this._user = session.user; return { authed: true, user: session.user }; }
    return null;
  },

  async signUp(email, password, name) {
    const sb = await ensureClient();
    const { data, error } = await withTimeout(sb.auth.signUp({ email, password, options: { data: { display_name: name } } }), T_AI, "signup");
    if (error) throw error;
    this._user = data.user;
    return data;
  },

  async signIn(email, password) {
    const sb = await ensureClient();
    const { data, error } = await withTimeout(sb.auth.signInWithPassword({ email, password }), T_AI, "signin");
    if (error) throw error;
    this._user = data.user;
    return data;
  },

  /** Send a one-time SMS code to the phone (E.164) via Supabase Phone Auth. */
  async sendPhoneOtp(phone) {
    const sb = await ensureClient();
    if (!sb) throw new Error("offline");
    const { error } = await withTimeout(sb.auth.signInWithOtp({ phone }), T_AI, "otp-send");
    if (error) throw error;
  },
  /** Verify the SMS code; signs in (creating the user if new). */
  async verifyPhoneOtp(phone, token) {
    const sb = await ensureClient();
    if (!sb) throw new Error("offline");
    const { data, error } = await withTimeout(sb.auth.verifyOtp({ phone, token, type: "sms" }), T_AI, "otp-verify");
    if (error) throw error;
    this._user = data.user;
    return data;
  },

  async signOut() {
    try { const sb = await ensureClient(); if (sb) await sb.auth.signOut(); } catch (_) {}
    this._user = null; this.leaderboardCache = null;
  },

  /** Send a password-reset email (Supabase built-in recovery flow). */
  async resetPassword(email) {
    const sb = await ensureClient();
    if (!sb) throw new Error("offline");
    const { error } = await withTimeout(sb.auth.resetPasswordForEmail(email), T_AI, "reset");
    if (error) throw error;
  },

  /** Permanently delete the signed-in user's account + ALL their data (GDPR /
   *  store requirement). Server-side erasure via the delete-account function,
   *  then clear the local session. */
  async deleteAccount() {
    await this._invoke("delete-account", { body: {} }, 20000);
    try { await this.signOut(); } catch (_) {}
  },

  /** Read profile + current unit progress -> a Talaqa state patch. Each query is
   *  timeout-bounded and falls back to null so a flaky network never stalls boot. */
  async loadProgress() {
    const sb = await ensureClient();
    if (!sb) return null;
    // Talaqa is client-authoritative: restore the user's SAVED STATE blob (level,
    // xp, streak, sections, chapters, settings...) — NOT backend defaults (which
    // would reset a returning user to "beginner").
    const saved = await this.loadState();
    const patch = (saved && typeof saved === "object") ? saved : {};
    try { patch._leaderboard = await this.getLeaderboard(8); } catch (_) {}
    // Referral stats + server-authoritative premium entitlement. Overrides any
    // stale premium_until from the client blob with the value the server computes.
    try { const st = await this.getReferralStats(); if (st) { patch.referralStats = st; patch.premium_until = st.premium_until || null; } } catch (_) {}
    return patch;
  },
  /** Save the whole Talaqa state blob to the user's private storage. */
  // Returns true on a successful upload, false on any failure (missing client/obj/uid
  // or a caught error). Never throws — the caller uses the boolean to flag a dirty
  // (unsynced) state and retry when connectivity returns.
  async saveState(obj) {
    const sb = await ensureClient();
    if (!sb || !obj) return false;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return false;
    try {
      const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
      const { error } = await sb.storage.from("user-recordings").upload(uid + "/state.json", blob, { upsert: true, contentType: "application/json" });
      if (error) return false;
      return true;
    } catch (_) { return false; }
  },
  /** Load the saved state blob (or null on first login / error). */
  async loadState() {
    const sb = await ensureClient();
    if (!sb) return null;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return null;
    let res;
    try { res = await withTimeout(sb.storage.from("user-recordings").download(uid + "/state.json"), T_DB, "loadState"); }
    catch (_) { const t = new Error("loadState transient"); t.transient = true; throw t; } // network/timeout -> caller must NOT overwrite cloud
    const { data, error } = res || {};
    if (error) {
      const m = (((error && error.message) || "") + "").toLowerCase();
      const code = ((error && (error.statusCode || error.status)) || "") + "";
      // genuine "no save yet" -> safe to start fresh + autosave. A 400 is NOT
      // genuine-empty (it's a recoverable/transient error) — treating it as null
      // would trigger a false fresh-start that overwrites real cloud state.
      if (m.includes("not found") || m.includes("does not exist") || m.includes("object not found") || code === "404") return null;
      const t = new Error("loadState transient"); t.transient = true; throw t; // unknown error -> don't clobber cloud
    }
    if (!data) return null;
    try { return JSON.parse(await data.text()); } catch (_) { return null; }
  },

  /** Persist onboarding answers + flip onboarding_completed (trusted RPC). */
  async completeOnboarding({ name, goal, age } = {}) {
    const sb = await ensureClient();
    if (!sb) return;
    const p_age = age != null && Number.isFinite(+age) ? +age : null;
    try { await withTimeout(sb.rpc("complete_onboarding", { p_display_name: name || null, p_goal: goal || null, p_age }), T_DB, "onboarding"); }
    catch (_) { /* best effort (e.g. unknown goal enum) */ }
  },

  async completeFoundations() {
    const sb = await ensureClient();
    if (!sb) return;
    try { await withTimeout(sb.rpc("complete_foundations"), T_DB, "foundations"); } catch (_) {}
  },

  /** Persist learner settings to user_settings (owner-writable; best-effort). */
  async saveSettings(patch) {
    const sb = await ensureClient();
    if (!sb) return;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return;
    try { await withTimeout(sb.from("user_settings").upsert(Object.assign({ user_id: uid }, patch), { onConflict: "user_id" }), T_DB, "settings"); } catch (_) {}
  },

  /** Store this device's web-push subscription so the reminder cron can reach it. */
  async savePushSubscription(sub) {
    const sb = await ensureClient();
    if (!sb || !sub) return false;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return false;
    try {
      const { error } = await sb.from("device_tokens").upsert(
        { user_id: uid, platform: "web", token: JSON.stringify(sub), last_seen_at: new Date().toISOString() },
        { onConflict: "token" },
      );
      return !error;
    } catch (_) { return false; }
  },
  /** Remove this user's web push registrations (reminder turned off). */
  async removePushSubscription() {
    const sb = await ensureClient();
    if (!sb) return;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return;
    try { await sb.from("device_tokens").delete().eq("user_id", uid).eq("platform", "web"); } catch (_) {}
  },

  async getLeaderboard(limit = 8) {
    const sb = await ensureClient();
    if (!sb) return null;
    const { data, error } = await withTimeout(sb.rpc("get_leaderboard", { p_period: "all_time", p_limit: limit }), T_DB, "leaderboard");
    if (error || !data) return null;
    const hues = [18, 250, 325, 160, 210, 40, 280];
    const rows = data.map((r, i) => ({
      rank: Number(r.rank),
      name: r.display_name || "متعلّم",
      initial: ((r.display_name || "؟").trim()[0]) || "؟",
      pts: r.total_xp || 0,
      hue: hues[i % hues.length],
      avatar: r.avatar_url || null, // participant photo (shown in the leaderboard)
      me: !!r.is_me,
    }));
    this.leaderboardCache = rows;
    return rows;
  },

  /** Save the user's avatar (small data URL) to profiles so it shows in the
   *  leaderboard for OTHER users. Owner-writable via RLS. Best-effort. */
  async saveAvatar(url) {
    const sb = await ensureClient();
    if (!sb) return false;
    let uid = this._user?.id;
    if (!uid) { try { uid = (await sb.auth.getUser()).data.user?.id; } catch (_) {} }
    if (!uid) return false;
    try { const { error } = await sb.from("profiles").update({ avatar_url: url || null }).eq("id", uid); return !error; } catch (_) { return false; }
  },

  // ---- Stage 2 strict path (used once content is hydrated with DB ids) ------
  async getSpeechToken() { return await this._invoke("speech-token", { method: "POST" }); },
  async conversationStart(unitId) { return await this._invoke("conversation", { body: { action: "start", unit_id: unitId } }); },
  async conversationReply(sessionId, text) { return await this._invoke("conversation", { body: { action: "reply", session_id: sessionId, user_transcript: text } }); },
  async conversationFinalize(sessionId, reason) { return await this._invoke("conversation", { body: { action: "finalize", session_id: sessionId, reason: reason || "completed" } }); },

  // ---- Talaqa lite AI (content-agnostic; OpenAI/Whisper; no DB ids) --------
  // Generate a full mini-lesson (listening/reading/grammar/writing) for a chapter.
  async generateLesson({ words, level, topic } = {}) {
    return await this._invoke("generate-lesson", { body: { words: words || [], level: level || "A1", topic: topic || "" } }, 45000);
  },
  // FAST: just the 5 words' example sentences (so examples appear quickly).
  async generateExamples({ words, level, topic } = {}) {
    return await this._invoke("generate-lesson", { body: { words: words || [], level: level || "A1", topic: topic || "", only: "examples" } }, 25000);
  },
  // Push the (client-authoritative) progress to the account so the leaderboard
  // shows real users and the level/streak persist + sync across devices.
  async syncProgress(xp, level, streak) {
    const sb = await ensureClient(); if (!sb) return;
    try { await withTimeout(sb.rpc("sync_progress", { p_total_xp: Math.max(0, Math.round(xp || 0)), p_level: level || null, p_streak: Math.max(0, Math.round(streak || 0)) }), T_DB, "sync"); } catch (_) {}
  },
  // ---- Referrals -----------------------------------------------------------
  /** Link the (new) caller to a referrer by code. Best-effort, never throws. */
  async claimReferral(code) {
    const sb = await ensureClient(); if (!sb || !code) return null;
    try { const { data } = await withTimeout(sb.rpc("claim_referral", { p_code: String(code) }), T_DB, "ref-claim"); return data; }
    catch (_) { return null; }
  },
  /** Caller just finished their FIRST unit -> qualify their referral (rewards the
   *  referrer). Best-effort, idempotent server-side, never throws. */
  async qualifyReferral() {
    const sb = await ensureClient(); if (!sb) return null;
    try { const { data } = await withTimeout(sb.rpc("qualify_referral"), T_DB, "ref-qualify"); return data; }
    catch (_) { return null; }
  },
  /** Caller's referral code + qualified/pending counts + months earned + premium_until. */
  async getReferralStats() {
    const sb = await ensureClient(); if (!sb) return null;
    const { data, error } = await withTimeout(sb.rpc("get_referral_stats"), T_DB, "ref-stats");
    if (error) throw error;
    return data;
  },
  async tutor({ targetWords, level, goal, history, userText, opener } = {}) {
    return await this._invoke("tutor", {
      body: {
        target_words: targetWords || [],
        level: level || "A1",
        goal: goal || "",
        history: history || [],
        user_text: userText || "",
        opener: !!opener,
      },
    });
  },
  _fname(blob) {
    const t = (blob && blob.type) || "";
    if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "audio.mp4";
    if (t.includes("ogg")) return "audio.ogg";
    if (t.includes("wav")) return "audio.wav";
    return "audio.webm";
  },
  // Multipart audio via RAW fetch (supabase-js invoke can mangle the FormData
  // boundary on some devices -> the function rejects it). This sets no
  // Content-Type so the browser adds the correct multipart boundary itself.
  async _postForm(name, fd, ms = T_AI) {
    const sb = await ensureClient();
    let token = SB_ANON;
    try { const { data: { session } } = await sb.auth.getSession(); if (session && session.access_token) token = session.access_token; } catch (_) {}
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    let res;
    try {
      res = await fetch(`${SB_URL}/functions/v1/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: SB_ANON },
        body: fd,
        signal: ctrl.signal,
      });
    } catch (e) { if (e && e.name === "AbortError") e.isTimeout = true; throw e; }
    finally { clearTimeout(to); }
    const txt = await res.text();
    let data = null; try { data = JSON.parse(txt); } catch (_) {}
    if (!res.ok) { const err = new Error((data && data.error) || ("HTTP " + res.status)); err.status = res.status; throw err; }
    return data;
  },
  async pronounce(audioBlob, expected) {
    const fd = new FormData();
    fd.append("audio", audioBlob, this._fname(audioBlob));
    fd.append("expected", expected || "");
    return await this._postForm("pronounce", fd);
  },
  async transcribe(audioBlob) {
    const fd = new FormData();
    fd.append("audio", audioBlob, this._fname(audioBlob));
    return await this._postForm("stt-proxy", fd);
  },
  // --- microphone capture (browser only) -------------------------------------
  // Hold a WARM mic stream so a record tap starts capturing INSTANTLY instead of
  // re-running getUserMedia (which re-initialises the audio pipeline — the source
  // of the "mic takes a moment to start hearing me" lag). Acquired on a voice
  // screen's entry (when permission is already granted) and released on nav-away
  // via releaseMic() so the OS recording indicator is never left on.
  async warmMic() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error("mic unavailable");
    if (this._micStream && this._micStream.active) return this._micStream;
    this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return this._micStream;
  },
  /** Stop + drop the warm mic stream (call on nav-away / app backgrounded). */
  releaseMic() {
    try { this.stopRecording(); } catch (_) {}
    try { if (this._micStream) this._micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this._micStream = null;
  },
  async _recordOnce(maxMs = 4000, opts) {
    opts = opts || {};
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error("mic unavailable");
    // Reuse the warm stream when we have one (instant start); otherwise acquire a
    // throwaway stream for this take and stop it when done.
    const warm = !!(this._micStream && this._micStream.active);
    const stream = warm ? this._micStream : await navigator.mediaDevices.getUserMedia({ audio: true });
    const releaseStream = () => { if (!warm) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} } };
    return await new Promise((resolve, reject) => {
      let mr;
      const chunks = [];
      // Pick a container the platform can actually ENCODE. iOS/Safari WKWebView only
      // produces audio/mp4 (AAC) and cannot encode webm at all, so we feature-detect
      // and prefer mp4 there; desktop Chrome falls through to its native webm/opus.
      // The old code passed no mimeType and defaulted the Blob to "audio/webm", which
      // mislabelled iOS AAC recordings as webm and made the STT/pronounce proxy reject
      // them — breaking the app's core voice features on iPhone.
      let chosen = "";
      try {
        const PREF = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm"];
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
          chosen = PREF.find((t) => MediaRecorder.isTypeSupported(t)) || "";
        }
      } catch (_) {}
      try { mr = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream); }
      catch (e) { try { mr = new MediaRecorder(stream); } catch (e2) { releaseStream(); return reject(e2); } }
      this._rec = mr;
      let hardStop = 0;
      // Voice-activity detection: auto-stop ~0.9s after the learner stops talking so
      // they never have to tap "done". maxMs stays as a hard safety cap. Disabled
      // with opts.vad === false.
      const vad = opts.vad === false ? null : this._startVad(stream, () => {
        try { if (mr.state !== "inactive") mr.stop(); } catch (_) {}
      }, opts);
      const cleanup = () => { if (hardStop) clearTimeout(hardStop); if (vad) vad.stop(); };
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => { cleanup(); releaseStream(); this._rec = null; resolve(new Blob(chunks, { type: mr.mimeType || chosen || "audio/mp4" })); };
      mr.onerror = (e) => { cleanup(); releaseStream(); this._rec = null; reject((e && e.error) || new Error("record error")); };
      mr.start();
      hardStop = setTimeout(() => { try { if (mr.state !== "inactive") mr.stop(); } catch (_) {} }, maxMs);
    });
  },
  // Web-Audio RMS meter -> fires onSilence() once the speaker has clearly spoken and
  // then gone quiet for opts.silenceMs. Guarded; a no-op (never auto-stops, leaving
  // the maxMs cap in charge) when Web Audio is unavailable.
  _startVad(stream, onSilence, opts) {
    opts = opts || {};
    const SILENCE_MS = opts.silenceMs || 900;   // quiet gap that ends a turn
    const MIN_MS = opts.minMs || 500;           // ignore the first instant (tap noise / lead-in)
    const START = opts.startLevel || 0.025;     // RMS above this = speech detected
    const STOP = opts.stopLevel || 0.012;       // RMS below this = silence
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return { stop() {} };
      const ctx = new AC();
      try { if (ctx.state === "suspended" && ctx.resume) ctx.resume(); } catch (_) {}
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024; an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const t0 = Date.now();
      let spoke = false, quietAt = 0, timer = 0, stopped = false;
      const finish = () => { if (stopped) return; stopped = true; try { onSilence(); } catch (_) {} };
      timer = setInterval(() => {
        if (stopped) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (now - t0 < MIN_MS) return;
        if (rms >= START) { spoke = true; quietAt = 0; }
        else if (spoke && rms < STOP) {
          if (!quietAt) quietAt = now;
          else if (now - quietAt >= SILENCE_MS) finish();
        }
      }, 60);
      return { stop() { stopped = true; try { clearInterval(timer); } catch (_) {} try { src.disconnect(); } catch (_) {} try { ctx.close(); } catch (_) {} } };
    } catch (_) { return { stop() {} }; }
  },
  /** Stop an in-flight recording early (tap-to-stop / cancel / nav-away). */
  stopRecording() { try { if (this._rec && this._rec.state !== "inactive") this._rec.stop(); } catch (_) {} },
  async recordThenScore(expected, maxMs = 6000, opts) { const blob = await this._recordOnce(maxMs, Object.assign({ silenceMs: 800 }, opts)); return await this.pronounce(blob, expected); },
  async recordThenTranscribe(maxMs = 15000, opts) {
    const onStop = opts && opts.onStop;
    const blob = await this._recordOnce(maxMs, Object.assign({ silenceMs: 1100, minMs: 700 }, opts));
    try { if (onStop) onStop(); } catch (_) {}
    return await this.transcribe(blob);
  },
  // Predicted public CDN url for a phrase's pre-generated clip — pure hashing, NO
  // network. Audio2 plays this DIRECTLY (no HEAD pre-check) so a cached clip starts
  // in a single round-trip and is HTTP-cached after; on a 404 the player falls back
  // to tts() to generate it. Key must match the tts function's clipKey(text,voice,0.9).
  async clipUrl(text, voice) {
    const t = (text || "").trim();
    if (!t) throw new Error("empty text");
    const v = voice || "fable";
    const key = await _clipKey(`${t}|${v}|0.9`);
    return `${SB_URL}/storage/v1/object/public/tts-cache/${key}.mp3`;
  },
  // Pre-warm a clip into the BROWSER HTTP CACHE by actually downloading its bytes
  // (a HEAD alone confirms existence but caches nothing). Called fire-and-forget on
  // voice-screen entry so the first play is served from cache (~instant) instead of
  // paying a cold origin fetch. Misses fall through to tts() to generate the clip.
  async prewarmClip(text, voice) {
    const t = (text || "").trim();
    if (!t) return null;
    try {
      const u = await this.clipUrl(t, voice);
      const r = await fetch(u, { method: "GET", cache: "force-cache" });
      if (r && r.ok) { try { await r.arrayBuffer(); } catch (_) {} return u; }  // drain -> cached
    } catch (_) { /* fall through to generate */ }
    try { return await this.tts(t, voice); } catch (_) { return null; }
  },

  // Real text-to-speech (OpenAI). Returns a cached object URL per phrase so
  // repeat plays are instant and free. De-dupes concurrent requests for the same
  // phrase, bounds the cache (LRU + revoke), and times out. Falls back (caller)
  // to the browser voice on error.
  async tts(text, voice) {
    const t = (text || "").trim();
    if (!t) throw new Error("empty text");
    this._ttsCache = this._ttsCache || new Map();
    this._ttsInflight = this._ttsInflight || new Map();
    if (this._ttsCache.has(t)) return this._ttsCache.get(t);
    if (this._ttsInflight.has(t)) return this._ttsInflight.get(t);
    const self = this;
    const p = (async () => {
      const v = voice || "fable";
      // 1) Try the public CDN clip first — instant, no auth, browser-cached. The
      //    key matches the tts function's clipKey(text,voice,speed=0.9).
      //    On a HIT, return the DIRECT public URL string (not a fetched blob/object
      //    URL): the <audio> element streams + HTTP-caches it natively, giving a
      //    faster first byte. A cheap HEAD just confirms the clip exists.
      try {
        const key = await _clipKey(`${t}|${v}|0.9`);
        const cdn = `${SB_URL}/storage/v1/object/public/tts-cache/${key}.mp3`;
        const c = new AbortController();
        const ct = setTimeout(() => c.abort(), 6000);
        let cr;
        try { cr = await fetch(cdn, { method: "HEAD", signal: c.signal }); } finally { clearTimeout(ct); }
        if (cr && cr.ok) {
          self._ttsCache.set(t, cdn);   // cache the plain url string
          return cdn;
        }
      } catch (_) { /* fall through to generate */ }

      // 2) MISS -> the function generates + stores it (next play is a CDN hit).
      const sb = await ensureClient();
      let token = SB_ANON;
      try { const { data: { session } } = await sb.auth.getSession(); if (session && session.access_token) token = session.access_token; } catch (_) {}
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), T_TTS);
      let res;
      try {
        res = await fetch(`${SB_URL}/functions/v1/tts`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, apikey: SB_ANON, "Content-Type": "application/json" },
          body: JSON.stringify({ text: t, voice: v }),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(to); }
      if (!res.ok) { const e = new Error("tts failed " + res.status); e.status = res.status; throw e; }
      const url = URL.createObjectURL(await res.blob());
      self._ttsCache.set(t, url);
      // LRU eviction: cap at 60 cached clips, revoking the oldest object URL.
      if (self._ttsCache.size > 60) {
        const oldest = self._ttsCache.keys().next().value;
        const oldUrl = self._ttsCache.get(oldest);
        self._ttsCache.delete(oldest);
        try { if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(oldUrl); } catch (_) {}
      }
      return url;
    })();
    this._ttsInflight.set(t, p);
    try { return await p; } finally { this._ttsInflight.delete(t); }
  },

  async gradeQuiz(args) { return await (async () => { const sb = await ensureClient(); const { data, error } = await sb.rpc("grade_quiz", args); if (error) throw error; return data; })(); },
  async recordPronunciation(args) { return await (async () => { const sb = await ensureClient(); const { data, error } = await sb.rpc("record_pronunciation", args); if (error) throw error; return data; })(); },
  async completeSection(unitId, section) { return await (async () => { const sb = await ensureClient(); const { data, error } = await sb.rpc("complete_section", { p_unit_id: unitId, p_section: section }); if (error) throw error; return data; })(); },
  async completeUnit(unitId) { return await (async () => { const sb = await ensureClient(); const { data, error } = await sb.rpc("complete_unit", { p_unit_id: unitId }); if (error) throw error; return data; })(); },

  /** Arabic-friendly message for an auth / network / server error. */
  friendlyError(err) {
    const status = (err && (err.status || (err.context && err.context.status))) || 0;
    const m = ((err && err.message) || "").toLowerCase();
    // This app signs in by PHONE OTP only — no email/password/confirm messages.
    if (err && (err.isTimeout || m.includes("timed out") || m.includes("aborted") || m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed"))) return "انقطع الاتصال — تأكد من الإنترنت وحاول مرة ثانية";
    if (status === 429 || m.includes("rate limit") || m.includes("too many") || m.includes("only request this after") || m.includes("over_sms") || m.includes("over_email")) return "محاولات كثيرة — انتظر دقيقة ثم حاول مرة ثانية";
    if (m.includes("limit reached") || m.includes("quota")) return "بلغت الحد اليومي — حاول غداً";
    if (status >= 500 || m.includes("internal error") || m.includes("database error")) return "الخادم مشغول الآن، حاول بعد قليل";
    if (m.includes("expired") || m.includes("otp_expired") || m.includes("invalid otp") || (m.includes("token") && (m.includes("invalid") || m.includes("not found")))) return "الرمز غير صحيح أو منتهٍ — اطلب رمزًا جديدًا";
    if (m.includes("blocked") || m.includes("fraudulent") || m.includes("60410") || m.includes("60605") || m.includes("prefix is blocked")) return "رقمك محظور مؤقتًا لدى مزوّد الرسائل بعد محاولات كثيرة (إجراء أمني تلقائي) — انتظر بضع ساعات أو استخدم رقمًا آخر";
    if (m.includes("signups not allowed") || m.includes("signup is disabled") || m.includes("otp_disabled")) return "التسجيل متوقّف مؤقتًا — حاول لاحقًا";
    if (m.includes("phone") || m.includes("sms")) return "تعذّر إرسال الرمز — تأكد من رقم جوالك وحاول مرة ثانية";
    if (m.includes("mic") || m.includes("permission") || m.includes("denied") || m.includes("notallowed") || m.includes("not allowed")) return "تعذّر الوصول للمايكروفون — فعّل الإذن وحاول";
    return "تعذّر إتمام العملية — حاول مرة ثانية";
  },
};

if (typeof window !== "undefined") {
  window.TalaqaBackend = TB;
  // Warm the TLS connection to Supabase Storage so the FIRST audio clip streams
  // without a cold DNS+TLS handshake (shaves ~100-300ms off first playback).
  try {
    if (SB_URL && typeof document !== "undefined" && document.head) {
      const origin = new URL(SB_URL).origin;
      [["preconnect", "anonymous"], ["dns-prefetch", null]].forEach(([rel, cors]) => {
        const l = document.createElement("link");
        l.rel = rel; l.href = origin; if (cors) l.crossOrigin = cors;
        document.head.appendChild(l);
      });
    }
  } catch (_) {}
  TB.init().then(() => { try { window.dispatchEvent(new Event("talaqa:ready")); } catch (_) {} });
}

export default TB;
