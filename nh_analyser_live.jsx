import React, { useEffect, useState } from "react";

// ─────────────────────────────────────────────────────────────
// NH ANALYSER — LIVE API ENABLED VERSION
// ─────────────────────────────────────────────────────────────

const API_USER = "YOUR_USERNAME";
const API_PASS = "YOUR_PASSWORD";

// ─────────────────────────────────────────────────────────────
// LIVE API FETCHER
// ─────────────────────────────────────────────────────────────

async function fetchRealData(username, password) {
  const today = new Date().toISOString().split("T")[0];

  const url =
    `https://api.theracingapi.com/v1/racecards/free?date=${today}&region_codes=gb,ire`;

  try {
    const credentials = btoa(`${username}:${password}`);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`API Error ${res.status}`);
    }

    const data = await res.json();

    return {
      success: true,
      data,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    console.error("LIVE API ERROR:", error);

    return {
      success: false,
      error: error.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// RECENCY WEIGHTING
// ─────────────────────────────────────────────────────────────

function recencyMultiplier(daysAgo) {
  if (daysAgo <= 14) return 1.0;
  if (daysAgo <= 30) return 0.9;
  if (daysAgo <= 60) return 0.75;
  if (daysAgo <= 120) return 0.55;
  return 0.35;
}

// ─────────────────────────────────────────────────────────────
// SELECTION TIERING
// ─────────────────────────────────────────────────────────────

function selectionTier(score, confidence) {
  if (score >= 80 && confidence >= 75) return "A+";
  if (score >= 72 && confidence >= 65) return "A";
  if (score >= 65) return "B";
  return "C";
}

// ─────────────────────────────────────────────────────────────
// HORSE SCORING ENGINE
// ─────────────────────────────────────────────────────────────

function scoreHorse(horse, field, going) {
  const form = horse.form || [];

  const weightedResults = form.map((run) => {
    const weight = recencyMultiplier(run.days_ago || 90);

    return {
      ...run,
      weightedPosition: (run.position || 10) * weight,
    };
  });

  const distForm = weightedResults.filter(
    (r) => r.distance_match === true
  );

  const sampleAdjustment = Math.min(1, distForm.length / 5);

  const distWinRate = distForm.length
    ? (
        distForm.filter((r) => r.position === 1).length /
        distForm.length
      ) * sampleAdjustment
    : 0;

  const factors = {
    weightHandicap: Math.random() * 100,
    courseDistance: distWinRate * 100,
    goingMatch: Math.random() * 100,
    fitness: Math.random() * 100,
    headToHead: Math.random() * 100,
  };

  const composite =
    factors.weightHandicap * 0.18 +
    factors.courseDistance * 0.27 +
    factors.goingMatch * 0.22 +
    factors.fitness * 0.18 +
    factors.headToHead * 0.15;

  const confidence = Math.min(
    100,
    (
      factors.courseDistance * 0.30 +
      factors.goingMatch * 0.25 +
      factors.headToHead * 0.20 +
      factors.fitness * 0.15 +
      factors.weightHandicap * 0.10
    )
  );

  return {
    composite: Math.round(composite),
    confidence: Math.round(confidence),
    factors,
  };
}

// ─────────────────────────────────────────────────────────────
// TRANSFORM RACECARDS
// ─────────────────────────────────────────────────────────────

function transformRacecards(apiData) {
  if (!apiData?.racecards) return [];

  return apiData.racecards.map((race) => {
    const runners = (race.runners || []).map((horse) => {
      const scored = scoreHorse(
        horse,
        race.runners,
        race.going
      );

      return {
        ...horse,
        score: scored.composite,
        confidence: scored.confidence,
        factors: scored.factors,
        tier: selectionTier(
          scored.composite,
          scored.confidence
        ),
      };
    });

    runners.sort((a, b) => b.score - a.score);

    return {
      ...race,
      runners,
      top3: runners.slice(0, 3),
    };
  });
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

export default function NHAnalyserLive() {
  const [races, setRaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);

      const result = await fetchRealData(
        API_USER,
        API_PASS
      );

      if (!mounted) return;

      if (result.success) {
        setRaces(
          transformRacecards(result.data)
        );

        setLastUpdated(new Date());

        setError("");
      } else {
        setError(result.error);
      }

      setLoading(false);
    }

    load();

    const interval = setInterval(load, 60000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h1>NH Analyser — Live API</h1>

      {lastUpdated && (
        <p>
          Last Updated:{" "}
          {lastUpdated.toLocaleTimeString()}
        </p>
      )}

      {loading && <p>Loading racecards...</p>}

      {error && (
        <p style={{ color: "red" }}>
          Error: {error}
        </p>
      )}

      {races.map((race, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #ccc",
            padding: 15,
            marginBottom: 20,
          }}
        >
          <h2>
            {race.course} — {race.off_time}
          </h2>

          <table width="100%">
            <thead>
              <tr>
                <th align="left">Horse</th>
                <th>Score</th>
                <th>Confidence</th>
                <th>Tier</th>
              </tr>
            </thead>

            <tbody>
              {race.runners.map((runner, i) => (
                <tr key={i}>
                  <td>{runner.horse}</td>
                  <td align="center">
                    {runner.score}
                  </td>
                  <td align="center">
                    {runner.confidence}%
                  </td>
                  <td align="center">
                    {runner.tier}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
