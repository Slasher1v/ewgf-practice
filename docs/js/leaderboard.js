// Online leaderboard: username + password accounts (Supabase Auth) and each
// player's best score per board. Everything here is optional: if Supabase
// isn't configured or can't be reached, the trainer works as before.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js?v=20261026141408";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

// Supabase logs in with an email, so each username gets a placeholder
// address that's never emailed. Players only ever see their username.
const EMAIL_DOMAIN = "players.ewgf-practice.app";
const emailFor = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const MIN_PASSWORD = 6;

export const BOARDS = [
  { id: "i13_count", tab: "Trainer", title: "i13 Electrics", unit: "total", counter: true,
    how: "Total i13 Electrics landed. Keeps adding up.", fmt: (v) => `${v}` },
  { id: "ewgf_streak", tab: "Trainer", title: "Electric streak", unit: "in a row",
    how: "Most Electrics in a row.", fmt: (v) => `${v}` },
  { id: "ewgf_rate50", tab: "Trainer", title: "Electric rate", unit: "of 50",
    how: "Best Electric rate over 50 attempts.", fmt: (v) => `${v * 2}%` },
  { id: "rhythm_combo", tab: "Rhythm", title: "Real-speed combo", unit: "combo",
    how: "Longest Rhythm combo at real speed.", fmt: (v) => `${v}` },
  { id: "df_streak", tab: "df+2", title: "Just-frame streak", unit: "in a row",
    how: "Most df+2 hits in a row at level 1.", fmt: (v) => `${v}` },
];
export const boardById = (id) => BOARDS.find((b) => b.id === id);

export const configured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let client = null;
let loading = null;
let user = null;          // { id, username }
const myBests = {};       // board id -> best value already saved online
const listeners = new Set();

export const onChange = (fn) => listeners.add(fn);
const notify = () => { for (const fn of listeners) fn(); };
export const currentUser = () => user;
export const myBest = (id) => myBests[id] ?? null;

async function getClient() {
  if (!configured()) throw new Error("The leaderboard isn't set up yet.");
  if (client) return client;
  if (!loading) {
    loading = import(SUPABASE_JS).then(({ createClient }) => {
      client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "ewgf-practice-auth" },
      });
      return client;
    }).catch((e) => {
      loading = null;
      throw new Error("Couldn't reach the leaderboard. Check your connection and try again.", { cause: e });
    });
  }
  return loading;
}

function friendly(error) {
  const msg = (error && error.message) || String(error);
  if (/invalid login credentials/i.test(msg)) return "Wrong username or password.";
  if (/already registered|already exists|duplicate|database error saving new user/i.test(msg)) return "That username is taken.";
  if (/rate limit|too many/i.test(msg)) return "Too many tries - wait a minute and try again.";
  if (/password/i.test(msg) && /least|short|weak/i.test(msg)) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (/failed to fetch|network/i.test(msg)) return "Couldn't reach the leaderboard. Check your connection and try again.";
  return msg;
}

async function setUser(authUser) {
  if (!authUser) {
    user = null;
    for (const k of Object.keys(myBests)) delete myBests[k];
    notify();
    return;
  }
  const sb = await getClient();
  const fallback = authUser.user_metadata?.username || authUser.email?.split("@")[0] || "player";
  user = { id: authUser.id, username: fallback };
  const [{ data: prof }, { data: scores }] = await Promise.all([
    sb.from("profiles").select("username").eq("id", authUser.id).maybeSingle(),
    sb.from("scores").select("category, value").eq("user_id", authUser.id),
  ]);
  if (prof?.username) user.username = prof.username;
  for (const k of Object.keys(myBests)) delete myBests[k];
  for (const s of scores || []) myBests[s.category] = s.value;
  notify();
}

// Restore a saved login (if any) when the page opens.
export async function init() {
  if (!configured()) return;
  try {
    const sb = await getClient();
    const { data } = await sb.auth.getSession();
    await setUser(data.session?.user ?? null);
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") setUser(null);
    });
  } catch (e) {
    console.warn("Leaderboard unavailable:", e);
  }
}

function checkFields(username, password) {
  username = (username || "").trim();
  if (!USERNAME_RE.test(username)) throw new Error("Usernames are 3-16 letters, numbers or _ (no spaces).");
  if ((password || "").length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  return username;
}

export async function signUp(username, password) {
  username = checkFields(username, password);
  const sb = await getClient();
  const { data, error } = await sb.auth.signUp({
    email: emailFor(username), password, options: { data: { username } },
  });
  if (error) throw new Error(friendly(error));
  if (!data.session) {
    // Supabase is still set to "Confirm email": nobody can receive that email.
    throw new Error("Account made, but email confirmation is switched on in Supabase - turn off \"Confirm email\" so players can sign in.");
  }
  await setUser(data.user);
}

export async function signIn(username, password) {
  username = (username || "").trim();
  if (!username || !password) throw new Error("Enter your username and password.");
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email: emailFor(username), password });
  if (error) throw new Error(friendly(error));
  await setUser(data.user);
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
  await setUser(null);
}

// Called by the tabs whenever a run ends or improves. Only talks to the
// server when it beats your saved best, so it's cheap to call often.
const pending = {};
export async function report(id, value) {
  if (!user || !boardById(id) || !(value > 0)) return false;
  if (value <= (myBests[id] ?? 0) || value <= (pending[id] ?? 0)) return false;
  pending[id] = value;
  try {
    const sb = await getClient();
    const { error } = await sb.rpc("submit_score", { p_category: id, p_value: Math.round(value) });
    if (error) throw error;
    myBests[id] = Math.max(myBests[id] ?? 0, value);
    notify();
    return true;
  } catch (e) {
    console.warn("Score not saved:", e);
    return false;
  } finally {
    if (pending[id] === value) delete pending[id];
  }
}

// Running-total boards: queue +1s and send them in small batches.
const queued = {};
let flushTimer = null;
export function add(id, amount = 1) {
  if (!user || !boardById(id)?.counter) return;
  queued[id] = (queued[id] ?? 0) + amount;
  if (!flushTimer) flushTimer = setTimeout(flush, 1500);
}
async function flush() {
  flushTimer = null;
  for (const id of Object.keys(queued)) {
    const amount = Math.min(queued[id], 20);
    queued[id] -= amount;
    if (queued[id] <= 0) delete queued[id];
    try {
      const sb = await getClient();
      const { data, error } = await sb.rpc("add_to_counter", { p_category: id, p_amount: amount });
      if (error) throw error;
      myBests[id] = data;
      notify();
    } catch (e) {
      console.warn("Score not saved:", e);
    }
  }
  if (Object.keys(queued).length && !flushTimer) flushTimer = setTimeout(flush, 1500);
}

export async function top(id, limit = 25) {
  const sb = await getClient();
  const { data, error } = await sb.from("scores")
    .select("user_id, value, achieved_at, profiles(username)")
    .eq("category", id)
    .order("value", { ascending: false })
    .order("achieved_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(friendly(error));
  return data.map((r) => ({ userId: r.user_id, username: r.profiles?.username ?? "?", value: r.value, at: r.achieved_at }));
}
