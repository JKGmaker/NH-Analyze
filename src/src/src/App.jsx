import React, { useEffect, useState } from "react";

// ─────────────────────────────────────────────────────────────
// NH ANALYSER — LIVE API v1.4.3
// Endpoints used:
//   Free:     GET /v1/racecards/free      (minimal runner data)
//   Basic:    GET /v1/racecards/basic     (adds last_run, form string)
//   Standard: GET /v1/racecards/standard  (adds runner.stats with going/distance breakdown)
//
// Scoring adapts to whichever plan's data is available.
// ─────────────────────────────────────────────────────────────

const BASE_URL = "https://api.theracingapi.com";

// ─────────────────────────────────────────────────────────────
// API LAYER — plan-aware fetcher
// ─────────────────────────────────────────────────────────────

async function apiFetch(path, creds) {
  const credentials = btoa(`${creds.user}:${creds.pass}`);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ": " + body.slice(0, 120) : ""}`);
  }
  return res.json();
}

// Try endpoints in descending richness; fall back on 403/401/404
async function fetchRacecards(creds) {
  const today = new Date().toISOString().split("T")[0];
  const query = `?date=${today}&region_codes=gb,ire`;

  const tiers = [
    { label: "standard", path: `/v1/racecards/standard${query}` },
    { label: "basic",    path: `/v1/racecards/basic${query}` },
    { label: "free",     path: `/v1/racecards/free${query}` },
  ];

  for (const tier of tiers) {
    try {
      const data = await apiFetch(tier.path, creds);
      return { success: true, data, tier: tier.label, fetchedAt: Date.now() };
    } catch (err) {
      if (/^(401|403|404)/.test(err.message)) continue;
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: "No racecard endpoint accessible for your plan." };
}

// ─────────────────────────────────────────────────────────────
// HELPERS: parse RunnerStatsBreakdown → { win%, place% }
// Schema: { total, first, second, third } all strings
// ─────────────────────────────────────────────────────────────

function parseBreakdown(bd) {
  if (!bd) return null;
  const total = parseInt(bd.total, 10) || 0;
  if (!total) return null;
  const first  = parseInt(bd.first,  10) || 0;
  const second = parseInt(bd.second, 10) || 0;
  const third  = parseInt(bd.third,  10) || 0;
  return {
    total,
    winPct:   first / total,
    placePct: (first + second + third) / total,
  };
}

function sampleAdj(total) { return Math.min(1, (total || 0) / 5); }

function breakdownScore(bd) {
  if (!bd) return null;
  return Math.min(100, (bd.winPct * 0.6 + bd.placePct * 0.4) * sampleAdj(bd.total) * 100);
}

// ─────────────────────────────────────────────────────────────
// GOING → stats field key (RunnerStats schema)
// ─────────────────────────────────────────────────────────────

function goingStatsKey(goingStr) {
  if (!goingStr) return null;
  const g = goingStr.toLowerCase();
  if (g.includes("firm") || g.includes("hard"))                               return "ground_firm_stats";
  if (g.includes("heavy"))                                                     return "ground_heavy_stats";
  if (g.includes("good to soft") || g.includes("soft") || g.includes("yielding")) return "ground_soft_stats";
  if (g.includes("good"))                                                      return "ground_good_stats";
  if (g.includes("standard") || g.includes("aw") || g.includes("all weather")) return "ground_aw_stats";
  return null;
}

// ─────────────────────────────────────────────────────────────
// SCORING FACTORS (each returns 0-100 or null if unavailable)
// ─────────────────────────────────────────────────────────────

function calcWeightHandicap(runner, allRunners) {
  const getRating = (r) => parseFloat(r.or ?? r.ofr ?? r.rpr ?? 0) || 0;
  const ratings = allRunners.map(getRating).filter(Boolean);
  if (!ratings.length) return null;
  const max = Math.max(...ratings);
  const mine = getRating(runner);
  if (!mine) return null;
  return Math.max(0, Math.min(100, ((mine - (max - 20)) / 20) * 100));
}

function calcGoingMatch(runner, todayGoing) {
  const key = goingStatsKey(todayGoing);
  if (!key || !runner.stats) return null;
  return breakdownScore(parseBreakdown(runner.stats[key]));
}

function calcCourseDistance(runner) {
  if (runner.stats?.course_distance_stats) {
    return breakdownScore(parseBreakdown(runner.stats.course_distance_stats));
  }
  if (Array.isArray(runner.form)) {
    const dr = runner.form.filter((r) => r.distance_match);
    if (!dr.length) return null;
    const adj = sampleAdj(dr.length);
    return Math.min(100, (
      (dr.filter((r) => r.position === 1).length / dr.length) * 0.6 +
      (dr.filter((r) => r.position <= 3).length / dr.length) * 0.4
    ) * adj * 100);
  }
  return null;
}

function calcDistance(runner) {
  if (!runner.stats?.distance_stats) return null;
  return breakdownScore(parseBreakdown(runner.stats.distance_stats));
}

function calcFitness(runner) {
  let days = null;
  if (runner.stats?.last_raced) {
    days = Math.round((Date.now() - new Date(runner.stats.last_raced)) / 86400000);
  } else if (runner.last_run != null) {
    days = parseInt(runner.last_run, 10);
  }
  if (days === null) return null;
  if (days < 7)   return 55;
  if (days <= 14) return 80;
  if (days <= 28) return 100;
  if (days <= 42) return 85;
  if (days <= 60) return 65;
  if (days <= 90) return 45;
  return 25;
}

function calcJockeyHorse(runner) {
  if (!runner.stats?.jockey_stats) return null;
  return breakdownScore(parseBreakdown(runner.stats.jockey_stats));
}

function calcRecentForm(runner) {
  const bd = runner.stats?.last_ten_races_stats ?? runner.stats?.last_twelve_months_stats;
  return bd ? breakdownScore(parseBreakdown(bd)) : null;
}

function calcTrainer14Day(runner) {
  const t = runner.trainer_14_days;
  if (!t) return null;
  const runs = parseInt(t.runs, 10) || 0;
  const wins = parseInt(t.wins, 10) || 0;
  if (!runs) return null;
  return Math.min(100, (wins / runs) * 333); // 30% strike = 100
}

// ─────────────────────────────────────────────────────────────
// COMPOSITE SCORER — weights re-normalised to available factors
// ─────────────────────────────────────────────────────────────

const WEIGHTS = {
  weightHandicap: 0.15,
  courseDistance:  0.20,
  distance:        0.10,
  goingMatch:      0.18,
  fitness:         0.15,
  recentForm:      0.12,
  jockeyHorse:     0.05,
  trainer14Day:    0.05,
};

function scoreHorse(runner, allRunners, todayGoing) {
  const raw = {
    weightHandicap: calcWeightHandicap(runner, allRunners),
    courseDistance:  calcCourseDistance(runner),
    distance:        calcDistance(runner),
    goingMatch:      calcGoingMatch(runner, todayGoing),
    fitness:         calcFitness(runner),
    recentForm:      calcRecentForm(runner),
    jockeyHorse:     calcJockeyHorse(runner),
    trainer14Day:    calcTrainer14Day(runner),
  };

  const available = Object.entries(raw).filter(([, v]) => v !== null);
  if (!available.length) return { composite: 50, confidence: 0, factors: raw, dataPoints: 0 };

  const totalW = available.reduce((s, [k]) => s + WEIGHTS[k], 0);
  let composite = 0;
  for (const [k, v] of available) composite += (v * WEIGHTS[k]) / totalW;

  const confidence = Math.min(100, (available.length / Object.keys(WEIGHTS).length) * 100);

  return { composite: Math.round(composite), confidence: Math.round(confidence), factors: raw, dataPoints: available.length };
}

function selectionTier(score, confidence) {
  if (score >= 80 && confidence >= 70) return "A+";
  if (score >= 72 && confidence >= 55) return "A";
  if (score >= 65) return "B";
  return "C";
}

// ─────────────────────────────────────────────────────────────
// TRANSFORM API DATA
// ─────────────────────────────────────────────────────────────

function transformRacecards(apiData) {
  if (!apiData?.racecards) return [];
  return apiData.racecards
    .filter((r) => !r.is_abandoned)
    .map((race) => {
      const runners = (race.runners || []).map((runner) => {
        const s = scoreHorse(runner, race.runners, race.going);
        return { ...runner, score: s.composite, confidence: s.confidence, factors: s.factors, dataPoints: s.dataPoints, tier: selectionTier(s.composite, s.confidence) };
      });
      runners.sort((a, b) => b.score - a.score);
      return { ...race, runners };
    });
}

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────

const TIER_STYLE = {
  "A+": { bg: "#00ff87", fg: "#0a0a0a" },
  "A":  { bg: "#00c9ff", fg: "#0a0a0a" },
  "B":  { bg: "#f5a623", fg: "#0a0a0a" },
  "C":  { bg: "#1e1e1e", fg: "#555" },
};

const FACTOR_LABELS = {
  weightHandicap: "Rating vs Field",
  courseDistance:  "Course & Distance",
  distance:        "Distance Record",
  goingMatch:      "Going Match",
  fitness:         "Fitness",
  recentForm:      "Recent Form",
  jockeyHorse:     "Jockey (this horse)",
  trainer14Day:    "Trainer 14-day",
};

function FactorBar({ label, value }) {
  if (value === null || value === undefined) return (
    <div style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", fontSize: 10, color: "#2a2a2a" }}>
      <span>{label}</span><span>n/a</span>
    </div>
  );
  const pct = Math.round(value);
  const color = pct >= 65 ? "#00ff87" : pct >= 40 ? "#f5a623" : "#ff4d4d";
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginBottom: 2 }}>
        <span>{label}</span><span style={{ color }}>{pct}</span>
      </div>
      <div style={{ background: "#151515", borderRadius: 2, height: 3 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width 0.5s ease", borderRadius: 2 }} />
      </div>
    </div>
  );
}

function RunnerRow({ runner, rank }) {
  const [open, setOpen] = useState(false);
  const t = TIER_STYLE[runner.tier] || TIER_STYLE["C"];
  const isTop = rank === 0;
  const sp = runner.odds?.[0]?.fractional ?? null;

  return (
    <div onClick={() => setOpen((o) => !o)} style={{
      padding: "9px 14px", borderBottom: "1px solid #111",
      borderLeft: isTop ? "2px solid #00ff87" : "2px solid transparent",
      background: isTop ? "rgba(0,255,135,0.03)" : "transparent",
      cursor: "pointer",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#2a2a2a", fontSize: 10, width: 14, textAlign: "right", flexShrink: 0 }}>{rank + 1}</span>
        <span style={{ background: t.bg, color: t.fg, fontSize: 9, fontWeight: 800, padding: "2px 5px", borderRadius: 3, minWidth: 22, textAlign: "center", flexShrink: 0 }}>
          {runner.tier}
        </span>
        {runner.silk_url && <img src={runner.silk_url} alt="" style={{ width: 16, height: 16, objectFit: "contain", flexShrink: 0 }} />}
        <span style={{ flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 12, color: isTop ? "#fff" : "#aaa", letterSpacing: 0.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {runner.horse || runner.horse_name || "—"}
        </span>
        {runner.trainer_14_days?.percent && (
          <span style={{ fontSize: 9, background: "#141414", color: "#555", padding: "1px 5px", borderRadius: 2, flexShrink: 0 }}>
            T {runner.trainer_14_days.percent}%
          </span>
        )}
        {sp && <span style={{ fontSize: 10, color: "#444", fontFamily: "'DM Mono', monospace", minWidth: 28, textAlign: "right", flexShrink: 0 }}>{sp}</span>}
        <span style={{ color: "#00ff87", fontFamily: "'DM Mono', monospace", fontSize: 14, fontWeight: 700, marginLeft: 4, flexShrink: 0 }}>{runner.score}</span>
        <span style={{ color: "#333", fontSize: 10, width: 30, textAlign: "right", flexShrink: 0 }}>{runner.confidence}%</span>
        <span style={{ color: "#2a2a2a", fontSize: 9, marginLeft: 2, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>

      <div style={{ paddingLeft: 38, marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {runner.jockey  && <span style={{ fontSize: 9, color: "#3a3a3a" }}>J: {runner.jockey}</span>}
        {runner.trainer && <span style={{ fontSize: 9, color: "#3a3a3a" }}>T: {runner.trainer}</span>}
        {(runner.or || runner.ofr) && <span style={{ fontSize: 9, color: "#3a3a3a" }}>OR {runner.or ?? runner.ofr}</span>}
        {runner.stats?.last_raced && <span style={{ fontSize: 9, color: "#3a3a3a" }}>LR {runner.stats.last_raced}</span>}
        {runner.headgear && <span style={{ fontSize: 9, color: "#f5a623" }}>{runner.headgear}</span>}
        <span style={{ fontSize: 9, color: "#1e1e1e" }}>{runner.dataPoints}/8 factors</span>
      </div>

      {open && (
        <div style={{ paddingLeft: 38, marginTop: 10, paddingBottom: 6 }}>
          {Object.entries(FACTOR_LABELS).map(([key, label]) => (
            <FactorBar key={key} label={label} value={runner.factors?.[key]} />
          ))}
        </div>
      )}
    </div>
  );
}

function RaceCard({ race }) {
  const [open, setOpen] = useState(true);
  const topPick = race.runners.find((r) => ["A+", "A"].includes(r.tier));

  return (
    <div style={{ background: "#0c0c0c", border: "1px solid #161616", borderRadius: 8, marginBottom: 12, overflow: "hidden" }}>
      <div onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", gap: 10, padding: "11px 14px",
        cursor: "pointer", background: "#0f0f0f", borderBottom: open ? "1px solid #161616" : "none",
      }}>
        <span style={{ color: "#00ff87", fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>{race.off_time}</span>
        <span style={{ color: "#fff", fontSize: 13, fontWeight: 600, flex: 1 }}>{race.course}</span>
        {race.going && <span style={{ color: "#444", fontSize: 9, background: "#161616", padding: "2px 7px", borderRadius: 3 }}>{race.going}</span>}
        {race.distance_f && <span style={{ color: "#333", fontSize: 9 }}>{race.distance_f}f</span>}
        {race.race_class && <span style={{ color: "#333", fontSize: 9 }}>Cl{race.race_class.replace(/\D/g, "")}</span>}
        {race.big_race && <span style={{ color: "#f5a623", fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>★</span>}
        {topPick && <span style={{ fontSize: 9, color: "#444", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>▲ {topPick.horse}</span>}
        <span style={{ color: "#2a2a2a", fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div>
          <div style={{ display: "flex", padding: "4px 14px 4px 54px", background: "#090909", borderBottom: "1px solid #111" }}>
            <span style={{ flex: 1, fontSize: 9, color: "#2a2a2a", textTransform: "uppercase", letterSpacing: 1 }}>Horse</span>
            <span style={{ fontSize: 9, color: "#2a2a2a", textTransform: "uppercase", letterSpacing: 1, marginRight: 44 }}>SP</span>
            <span style={{ fontSize: 9, color: "#2a2a2a", textTransform: "uppercase", letterSpacing: 1, marginRight: 8 }}>Score</span>
            <span style={{ fontSize: 9, color: "#2a2a2a", textTransform: "uppercase", letterSpacing: 1, width: 30, textAlign: "right" }}>Conf</span>
            <span style={{ width: 16 }} />
          </div>
          {race.runners.map((r, i) => <RunnerRow key={r.horse_id ?? i} runner={r} rank={i} />)}
        </div>
      )}
    </div>
  );
}

function LoginForm({ onLogin, error }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const ready = user.trim() && pass.trim();
  const inp = {
    background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 6,
    color: "#fff", padding: "10px 13px", fontSize: 13,
    fontFamily: "'DM Mono', monospace", outline: "none", width: "100%", boxSizing: "border-box",
  };
  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: 32, background: "#0c0c0c", border: "1px solid #161616", borderRadius: 10 }}>
      <div style={{ color: "#00ff87", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>NH Analyser</div>
      <div style={{ color: "#fff", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Connect to API</div>
      <div style={{ color: "#333", fontSize: 11, marginBottom: 24 }}>theracingapi.com · Free, Basic or Standard plan</div>
      {error && (
        <div style={{ background: "rgba(255,77,77,0.07)", border: "1px solid rgba(255,77,77,0.15)", borderRadius: 6, padding: "10px 12px", marginBottom: 16, color: "#ff6b6b", fontSize: 11 }}>
          {error}
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <label style={{ color: "#333", fontSize: 10, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: 1 }}>Username</label>
        <input style={inp} value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" autoComplete="username" />
      </div>
      <div style={{ marginBottom: 22 }}>
        <label style={{ color: "#333", fontSize: 10, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: 1 }}>Password</label>
        <input style={inp} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••"
          onKeyDown={(e) => e.key === "Enter" && ready && onLogin(user.trim(), pass.trim())} />
      </div>
      <button
        onClick={() => ready && onLogin(user.trim(), pass.trim())}
        style={{
          width: "100%", padding: "11px 0",
          background: ready ? "#00ff87" : "#141414", color: ready ? "#0a0a0a" : "#2a2a2a",
          border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700,
          cursor: ready ? "pointer" : "default", letterSpacing: 0.5, transition: "all 0.2s",
        }}
      >
        FETCH TODAY'S CARDS
      </button>
    </div>
  );
}

export default function NHAnalyserLive() {
  const [creds, setCreds]             = useState(null);
  const [races, setRaces]             = useState([]);
  const [loading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [planTier, setPlanTier]       = useState(null);
  const [error, setError]             = useState("");

  useEffect(() => {
    if (!creds) return;
    let active = true;

    async function load() {
      setLoading(true);
      const result = await fetchRacecards(creds);
      if (!active) return;
      if (result.success) {
        setRaces(transformRacecards(result.data));
        setLastUpdated(new Date());
        setPlanTier(result.tier);
        setError("");
      } else {
        setError(result.error);
      }
      setLoading(false);
    }

    load();
    const iv = setInterval(load, 60_000);
    return () => { active = false; clearInterval(iv); };
  }, [creds]);

  const topSelections = races
    .flatMap((r) => r.runners.slice(0, 1).map((ru) => ({ ...ru, course: r.course, off_time: r.off_time })))
    .filter((r) => ["A+", "A"].includes(r.tier))
    .sort((a, b) => b.score - a.score);

  const today = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#fff", fontFamily: "'DM Sans', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ borderBottom: "1px solid #0f0f0f", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#080808", zIndex: 10 }}>
        <div style={{ display: "f
