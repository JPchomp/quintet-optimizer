import React, { useMemo, useState } from "react";

/**
 * ------------------------------------------------------------
 * QUINTET LINEUP OPTIMIZER (Submission-only, Winner-stays)
 * ------------------------------------------------------------
 * Fixes: closes all JSX strings/tags and adds a Diagnostics & Tests panel.
 * 
 * What this file does:
 * 1) Lets you enter two 5-person teams (Our vs Opp): name, weight, CONDITION (1–10), TECH (1–10).
 * 2) Converts those to matchup probabilities using a normalized, NONLINEAR advantage and a LOGISTIC mapping.
 * 3) Includes a DRAW model and a FATIGUE PENALTY for consecutive fights (winner-stays).
 * 4) Evaluates ALL win/lose/draw branches via dynamic programming (DP) for any pair of orders.
 * 5) Searches all 5! permutations of our lineup and recommends the order that maximizes expected net wins.
 * 6) "Robust" mode chooses our order that maximizes the WORST-CASE EV across ALL opponent orders.
 * 7) Diagnostics panel runs simple tests to catch regressions or parameter nonsense.
 *
 * Parameter glossary:
 * - Weight importance: multiplier converting kg difference to normalized units.
 * - Nonlinearity exponent (gamma > 1): makes bigger edges disproportionately strong.
 * - Logistic slope (alpha): how sharply normalized advantage converts to P(win).
 * - Draw base / decay / cap: baseline draw chance, how fast it shrinks, and its ceiling.
 * - Condition (1–10): mapped to a 0.85–1.15 multiplier on weight.
 * - Technical ability (1–10): converted to a few "kg" of edge per point (skillKg), scaled by skillSlope.
 * - Streak penalty: per extra consecutive fight, effective condition is reduced for that athlete.
 */

// ============================================================
// =                         UTILITIES                        =
// ============================================================
/**
 * clamp(x, lo, hi)
 * Ensures x stays within [lo, hi]. Used for probabilities and factors.
 */
function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * sigmoid(z)
 * Logistic function mapping real numbers to (0,1). Used to convert advantage to P(win).
 */
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * permutations(arr)
 * Generates all permutations of a short array (Heap's algorithm). 5! = 120, fine for UI.
 * @param {any[]} arr - the array of indices to permute
 * @returns {any[][]} - list of permutations
 */
function permutations(arr) {
  const res = [];
  const a = arr.slice();
  const c = new Array(a.length).fill(0);
  res.push(a.slice());
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      if (i % 2 === 0) [a[0], a[i]] = [a[i], a[0]]; else [a[c[i]], a[i]] = [a[i], a[c[i]]];
      res.push(a.slice());
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return res;
}

// ============================================================
// =                        DEFAULT DATA                      =
// ============================================================
/**
 * defaultTeam(namePrefix)
 * YOUR supplied roster. Names are fixed; condition/tech default to mid-high.
 * We keep condition/tech available (1–10) so you can edit them in UI.
 */
function defaultTeam(namePrefix) {
  return [
    { name: "JP",     weight: 62,  condition: 10, tech: 10 },
    { name: "FLORIS", weight: 67,  condition: 10, tech: 10 },
    { name: "ALEX",   weight: 79,  condition: 10, tech: 10 },
    { name: "NIELS",  weight: 87,  condition: 10, tech: 10 },
    { name: "NOAH",   weight: 122, condition: 10, tech: 10 },
  ];
}

/**
 * defaultTeamOthers(namePrefix)
 * Opponent roster initialized to 85 kg each, with editable condition/tech.
 */
function defaultTeamOthers(namePrefix) {
  return [
    { name: `${namePrefix} 1`, weight: 85, condition: 10, tech: 10 },
    { name: `${namePrefix} 2`, weight: 85, condition: 10, tech: 10 },
    { name: `${namePrefix} 3`, weight: 85, condition: 10, tech: 10 },
    { name: `${namePrefix} 4`, weight: 85, condition: 10, tech: 10 },
    { name: `${namePrefix} 5`, weight: 85, condition: 10, tech: 10 },
  ];
}

// ============================================================
// =                           UI                             =
// ============================================================
/**
 * TextInput({ label, value, onChange, step, min, max, help })
 * Generic numeric input with label and optional help text.
 */
function TextInput({ label, value, onChange, step = 1, min, max, help }) {
  return (
    <label className="block text-sm mb-2">
      <span className="text-gray-800 font-medium">{label}</span>
      {help && <div className="text-xs text-gray-500 mb-1">{help}</div>}
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 block w-full rounded-xl border p-2"
      />
    </label>
  );
}

/**
 * RosterEditor({ team, setTeam, title })
 * Small editor for a 5-person roster. Shows live total weight.
 * Lets you edit name, weight, condition (1–10), and technical ability (1–10).
 */
function RosterEditor({ team, setTeam, title }) {
  const update = (idx, key, val) => {
    const t = team.slice();
    t[idx] = { ...t[idx], [key]: val };
    setTeam(t);
  };
  const total = team.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        <div className="text-sm text-gray-700">Total weight: <span className="font-semibold">{total.toFixed(1)} kg</span></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {team.map((p, idx) => (
          <div key={idx} className="border rounded-xl p-3">
            <div className="font-medium mb-1">{p.name}</div>
            <label className="block text-sm">Name
              <input className="w-full border rounded-md p-1 mt-1" value={p.name} onChange={(e)=>update(idx, 'name', e.target.value)} />
            </label>
            <label className="block text-sm mt-2">Weight (kg)
              <input type="number" className="w-full border rounded-md p-1 mt-1" value={p.weight} onChange={(e)=>update(idx, 'weight', parseFloat(e.target.value))} />
            </label>
            <label className="block text-sm mt-2">Condition (1–10)
              <input type="number" step={1} min={1} max={10} className="w-full border rounded-md p-1 mt-1" value={p.condition} onChange={(e)=>update(idx, 'condition', parseFloat(e.target.value))} />
            </label>
            <label className="block text-sm mt-2">Technical ability (1–10)
              <input type="number" step={1} min={1} max={10} className="w-full border rounded-md p-1 mt-1" value={p.tech} onChange={(e)=>update(idx, 'tech', parseFloat(e.target.value))} />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// =                    PROBABILITY MODEL                     =
// ============================================================
/**
 * conditionFactor(c)
 * Map Condition 1–10 to a smooth multiplier on weight.
 * 1 → 0.85   5 → 1.00   10 → 1.15
 */
function conditionFactor(c) {
  const cClamped = clamp((c - 1) / 9, 0, 1); // 0..1
  return 0.85 + 0.30 * cClamped; // 0.85..1.15
}

/**
 * fatigueFactor(streak, streakPenalty)
 * Apply a linear penalty per extra consecutive fight for the SAME athlete.
 * streak = 1 (fresh on mat) → factor 1.0
 * streak = 2 → 1 - streakPenalty
 * streak = 3 → 1 - 2*streakPenalty, etc. clipped at 0.7 minimum.
 */
function fatigueFactor(streak, streakPenalty) {
  const extra = Math.max(0, streak - 1);
  return clamp(1 - streakPenalty * extra, 0.7, 1);
}

/**
 * skillBias(techA, techB, params)
 * Convert TECH difference to a normalized bias equivalent to a few kg.
 * - skillKg: how many kg each TECH point is worth
 * - weightImportance: kg → logistic units multiplier
 * - skillSlope: extra multiplier on the bias in logistic input
*/
function skillBias(techA, techB, params) {
  const diffTech = (techA || 0) - (techB || 0); // allow undefined tech
  const units = params.weightImportance * params.skillKg * diffTech; // kg → normalized units
  return params.skillSlope * units;
}

/**
 * probabilityModel(a, b, params, streakA, streakB)
 * Returns P(win), P(draw), P(lose) for athlete a vs b, adjusting for condition, tech, and fatigue streaks.
 * - a, b: athlete objects { weight, condition(1–10), tech(1–10) }
 * - params: model knobs
 * - streakA, streakB: consecutive bouts the current athletes have already fought (1 = fresh on mat)
 */
function probabilityModel(a, b, params, streakA = 1, streakB = 1) {
  // Effective weight with condition and fatigue
  const effA = a.weight * conditionFactor(a.condition) * fatigueFactor(streakA, params.streakPenalty);
  const effB = b.weight * conditionFactor(b.condition) * fatigueFactor(streakB, params.streakPenalty);

  // Weight difference scaled then apply nonlinearity (gamma)
  const raw = params.weightImportance * (effA - effB); // normalized units
  const mag = Math.pow(Math.abs(raw), params.gamma);
  const signed = Math.sign(raw) * mag;

  // Add technical bias, then pass through logistic (alpha)
  const z = params.alpha * (signed + skillBias(a.tech, b.tech, params));
  const pWinRaw = sigmoid(z);

  // Draw probability shrinks as the absolute advantage grows
  const pDraw = clamp(
    params.drawBase * Math.exp(-params.drawDecay * Math.abs(raw)),
    0,
    params.drawCap
  );

  // Allocate remaining mass to win/loss
  const pWin = clamp((1 - pDraw) * pWinRaw, 0, 1);
  const pLose = clamp(1 - pDraw - pWin, 0, 1);

  return { pWin, pDraw, pLose, rawAdvantage: raw, effA, effB };
}

// ============================================================
// =          DYNAMIC PROGRAMMING (ALL OUTCOME PATHS)         =
// ============================================================
/**
 * expectedNetWins(our, opp, params)
 * DP over states (i, j, si, sj) where:
 *  - i: index of our current athlete
 *  - j: index of their current athlete
 *  - si: our athlete's consecutive-fight streak (starts at 1)
 *  - sj: their athlete's consecutive-fight streak (starts at 1)
 * Transitions (winner-stays, draws remove both):
 *  - Win:   reward +1, state → (i,   j+1, si+1, 1)
 *  - Lose:  reward −1, state → (i+1, j,   1,    sj+1)
 *  - Draw:  reward 0,  state → (i+1, j+1, 1,    1)
 */
function expectedNetWins(our, opp, params) {
  const n = our.length;
  const m = opp.length;
  const memo = new Map();
  const key = (i, j, si, sj) => `${i},${j},${si},${sj}`;

  function f(i, j, si, sj) {
    if (i >= n || j >= m) return 0; // terminal
    const k = key(i, j, si, sj);
    if (memo.has(k)) return memo.get(k);

    const { pWin, pDraw, pLose } = probabilityModel(our[i], opp[j], params, si, sj);

    const val =
      pWin * (1 + f(i, j + 1, si + 1, 1)) +
      pLose * (-1 + f(i + 1, j, 1, sj + 1)) +
      pDraw * (0 + f(i + 1, j + 1, 1, 1));

    memo.set(k, val);
    return val;
  }

  return f(0, 0, 1, 1);
}

/**
 * expectedOurWins(our, opp, params)
 * Same DP but counting only our wins (diagnostic). Not used in the main UI.
 */
function expectedOurWins(our, opp, params) {
  const n = our.length;
  const m = opp.length;
  const memo = new Map();
  const key = (i, j, si, sj) => `${i},${j},${si},${sj}`;
  function f(i, j, si, sj) {
    if (i >= n || j >= m) return 0;
    const k = key(i, j, si, sj);
    if (memo.has(k)) return memo.get(k);
    const { pWin, pDraw, pLose } = probabilityModel(our[i], opp[j], params, si, sj);
    const val = pWin * (1 + f(i, j + 1, si + 1, 1)) + pLose * (0 + f(i + 1, j, 1, sj + 1)) + pDraw * (0 + f(i + 1, j + 1, 1, 1));
    memo.set(k, val);
    return val;
  }
  return f(0, 0, 1, 1);
}

// ============================================================
// =                 SEARCH OUR LINEUP ORDERS                 =
// ============================================================
/**
 * optimizeOurOrder(our, opp, params)
 * Brute-force our 5! orders; score EV vs current opponent order.
 * Returns best order and the top-5 list for transparency.
 */
function optimizeOurOrder(our, opp, params) {
  const idxs = our.map((_, i) => i);
  const perms = permutations(idxs);
  let best = null;
  const top = [];
  for (const ord of perms) {
    const ourOrd = ord.map((i) => our[i]);
    const ev = expectedNetWins(ourOrd, opp, params);
    top.push({ order: ord.slice(), ev });
    if (!best || ev > best.ev) best = { order: ord.slice(), ev };
  }
  top.sort((a, b) => b.ev - a.ev);
  return { best, top: top.slice(0, 5) };
}

/**
 * robustOurOrder(our, opp, params)
 * Maximize our MINIMUM EV over ALL opponent orders (their best response).
 */
function robustOurOrder(our, opp, params) {
  const ourIdxs = our.map((_, i) => i);
  const oppIdxs = opp.map((_, i) => i);
  const ourPerms = permutations(ourIdxs);
  const oppPerms = permutations(oppIdxs);
  let best = null;
  const top = [];
  for (const ord of ourPerms) {
    const ourOrd = ord.map((i) => our[i]);
    let worst = Infinity;
    for (const oppOrdIdxs of oppPerms) {
      const oppOrd = oppOrdIdxs.map((i) => opp[i]);
      const ev = expectedNetWins(ourOrd, oppOrd, params);
      worst = Math.min(worst, ev);
    }
    top.push({ order: ord.slice(), ev: worst });
    if (!best || worst > best.ev) best = { order: ord.slice(), ev: worst };
  }
  top.sort((a, b) => b.ev - a.ev);
  return { best, top: top.slice(0, 5) };
}

/**
 * optimizeOurOrderWithFirst(our, opp, params, firstIdx)
 * Optimize assuming our player `firstIdx` must go first.
 */
function optimizeOurOrderWithFirst(our, opp, params, firstIdx) {
  const remaining = our.map((_, i) => i).filter((i) => i !== firstIdx);
  const perms = permutations(remaining);
  let best = null;
  for (const perm of perms) {
    const ord = [firstIdx, ...perm];
    const ourOrd = ord.map((i) => our[i]);
    const ev = expectedNetWins(ourOrd, opp, params);
    if (!best || ev > best.ev) best = { order: ord.slice(), ev };
  }
  return best;
}

/**
 * robustOurOrderWithFirst(our, opp, params, firstIdx)
 * Robust counterpart with player `firstIdx` fixed first.
 */
function robustOurOrderWithFirst(our, opp, params, firstIdx) {
  const remaining = our.map((_, i) => i).filter((i) => i !== firstIdx);
  const ourPerms = permutations(remaining);
  const oppIdxs = opp.map((_, i) => i);
  const oppPerms = permutations(oppIdxs);
  let best = null;
  for (const perm of ourPerms) {
    const ord = [firstIdx, ...perm];
    const ourOrd = ord.map((i) => our[i]);
    let worst = Infinity;
    for (const oppOrdIdxs of oppPerms) {
      const oppOrd = oppOrdIdxs.map((i) => opp[i]);
      const ev = expectedNetWins(ourOrd, oppOrd, params);
      worst = Math.min(worst, ev);
    }
    if (!best || worst > best.ev) best = { order: ord.slice(), ev: worst };
  }
  return best;
}

/**
 * pickOppBestOrderAgainst(our, opp, params)
 * For a fixed our-order, find opponent order minimizing our EV (their best response).
 */
function pickOppBestOrderAgainst(our, opp, params) {
  const oppIdxs = opp.map((_, i) => i);
  const oppPerms = permutations(oppIdxs);
  let worst = null;
  for (const oppOrdIdxs of oppPerms) {
    const oppOrd = oppOrdIdxs.map((i) => opp[i]);
    const ev = expectedNetWins(our, oppOrd, params);
    if (!worst || ev < worst.ev) worst = { order: oppOrdIdxs.slice(), ev };
  }
  return worst;
}

// ============================================================
// =                           APP                            =
// ============================================================
/**
 * App()
 * Wires together rosters, parameter controls, optimization mode, results, and diagnostics.
 */
export default function App() {
  // Team state (use YOUR supplied default team and the defaultTeamOthers for opponents)
  const [ourTeam, setOurTeam] = useState(defaultTeam("Our"));
  const [oppTeam, setOppTeam] = useState(defaultTeamOthers("Opp"));

  // Model knobs
  const [alpha, setAlpha] = useState(1.1);        // logistic slope
  const [gamma, setGamma] = useState(1.1);        // nonlinearity exponent
  const [weightImportance, setWeightImportance] = useState(0.1); // kg → units multiplier
  const [drawBase, setDrawBase] = useState(0.8);  // draw chance near even
  const [drawDecay, setDrawDecay] = useState(1.05); // how fast draws shrink
  const [drawCap, setDrawCap] = useState(0.9);    // ceiling on draws
  const [skillKg, setSkillKg] = useState(2.5);      // kg per TECH point
  const [skillSlope, setSkillSlope] = useState(1.0); // multiplier on skill bias
  const [streakPenalty, setStreakPenalty] = useState(0.1); // per extra consecutive fight (8% drop per bout)
  const [mode, setMode] = useState("robust");     // robust | exploit | our_only

  const params = { alpha, gamma, weightImportance, drawBase, drawDecay, drawCap, skillKg, skillSlope, streakPenalty };

  // Compute optimal order according to mode
  const result = useMemo(() => {
    if (mode === "our_only") return optimizeOurOrder(ourTeam, oppTeam, params);
    if (mode === "exploit")   return optimizeOurOrder(ourTeam, oppTeam, params);
    return robustOurOrder(ourTeam, oppTeam, params);
  }, [ourTeam, oppTeam, alpha, gamma, weightImportance, drawBase, drawDecay, drawCap, skillKg, skillSlope, streakPenalty, mode]);

  // Extract recommended order and opponent best response
  const bestOurOrderIdxs = result?.best?.order || [];
  const bestOurOrder = bestOurOrderIdxs.map((i) => ourTeam[i]);

  const oppBestResponse = useMemo(() => {
    if (bestOurOrder.length === 0) return null;
    return pickOppBestOrderAgainst(bestOurOrder, oppTeam, params);
  }, [bestOurOrder, oppTeam, params]);

  // Best orders with each of our players forced to start
  const forcedFirst = useMemo(() => {
    return ourTeam.map((_, i) => {
      const res = mode === "robust"
        ? robustOurOrderWithFirst(ourTeam, oppTeam, params, i)
        : optimizeOurOrderWithFirst(ourTeam, oppTeam, params, i);
      return { first: i, order: res.order, ev: res.ev };
    });
  }, [ourTeam, oppTeam, alpha, gamma, weightImportance, drawBase, drawDecay, drawCap, skillKg, skillSlope, streakPenalty, mode]);

  /**
   * OrderBadge({ label, team, orderIdxs })
   * Visually render a lineup order as labeled chips.
   */
  function OrderBadge({ label, team, orderIdxs }) {
    return (
      <div className="rounded-2xl border p-3">
        <div className="font-semibold mb-2">{label}</div>
        <ol className="flex flex-wrap gap-2">
          {orderIdxs.map((idx, k) => (
            <li key={k} className="px-3 py-1 rounded-full bg-gray-100 border">
              {team[idx].name}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  /**
  * ProbPreview()
  * Quick sanity panel to show current probability breakdown for our player 5 vs opponent player 1,
  * with streaks assumed = 1 (fresh on mat).
  */
  const ProbPreview = () => {
    const a = ourTeam[4];
    const b = oppTeam[0];
    const { pWin, pDraw, pLose, rawAdvantage } = probabilityModel(a, b, params, 1, 1);
    return (
      <div className="rounded-2xl border p-3">
        <div className="font-semibold mb-2">Probability model preview (Our[5] vs Opp[1])</div>
        <div className="text-sm">Scaled advantage (units): {rawAdvantage.toFixed(3)}</div>
        <div className="text-sm">P(win): {(pWin * 100).toFixed(1)}% | P(draw): {(pDraw * 100).toFixed(1)}% | P(lose): {(pLose * 100).toFixed(1)}%</div>
      </div>
    );
  };

  // Display opponent total weight explicitly
  const oppTotal = oppTeam.reduce((s, p) => s + (Number(p.weight) || 0), 0);

  // -------------------- Diagnostics & Tests --------------------
  /**
   * runTests()
   * Executes simple invariants and sanity checks. Returns an array of { name, passed, info }.
   */
  function runTests() {
    const tests = [];

    // Test 1: probabilities sum ~ 1
    {
      const a = { weight: 100, condition: 8, tech: 7 };
      const b = { weight: 90,  condition: 8, tech: 7 };
      const { pWin, pDraw, pLose } = probabilityModel(a, b, params, 1, 1);
      const sum = pWin + pDraw + pLose;
      tests.push({ name: "Probabilities sum to ~1", passed: Math.abs(sum - 1) < 1e-9, info: `All combinations → sum=${sum.toFixed(6)}` });
    }

    // Test 2: heavier advantage increases win probability
    {
      const baseA = { weight: 90, condition: 8, tech: 7 };
      const baseB = { weight: 90, condition: 8, tech: 7 };
      const p0 = probabilityModel(baseA, baseB, params, 1, 1).pWin;
      const heavier = probabilityModel({ ...baseA, weight: 100 }, baseB, params, 1, 1).pWin;
      tests.push({ name: "Heavier → higher P(win)", passed: heavier > p0, info: `Δweight=+10kg win chance variation: p0=${p0.toFixed(3)} → p1=${heavier.toFixed(3)}` });
    }

    // Test 3: draws shrink with larger absolute advantage
    {
      const a = { weight: 100, condition: 8, tech: 7 };
      const b = { weight: 90,  condition: 8, tech: 7 }; // 10kg diff
      const c = { weight: 70,  condition: 8, tech: 7 }; // 30kg diff
      const d1 = probabilityModel(a, b, params, 1, 1).pDraw;
      const d2 = probabilityModel(a, c, params, 1, 1).pDraw;
      tests.push({ name: "Draw chance variation", passed: d2 < d1, info: `diff1=10kg→${d1.toFixed(3)}, diff2=30kg→${d2.toFixed(3)}` });
    }

    // Test 4: higher CONDITION increases P(win)
    {
      const a = { weight: 90, condition: 9, tech: 7 };
      const b = { weight: 90, condition: 5, tech: 7 };
      const highCond = probabilityModel(a, b, params, 1, 1).pWin;
      const lowCond  = probabilityModel({ ...a, condition: 5 }, { ...b, condition: 9 }, params, 1, 1).pWin;
      tests.push({ name: "Condition P(win) variation", passed: highCond > lowCond, info: `Δcond=+4: p0=${highCond.toFixed(3)} → p1=${lowCond.toFixed(3)}` });
    }

    // Test 5: fatigue penalty reduces P(win) when streak grows
    {
      const a = { weight: 90, condition: 8, tech: 7 };
      const b = { weight: 90, condition: 8, tech: 7 };
      const pFresh = probabilityModel(a, b, params, 1, 1).pWin;
      const pTired = probabilityModel(a, b, params, 3, 1).pWin;
      tests.push({ name: "Fatigue reduces P(win)", passed: pTired < pFresh, info: `Δstreak=+2, 90vs90kg: fresh=${pFresh.toFixed(3)}, tired=${pTired.toFixed(3)}` });
    }

    // Test 6: higher TECH increases P(win)
    {
      const a = { weight: 90, condition: 8, tech: 9 };
      const b = { weight: 90, condition: 8, tech: 5 };
      const pHighTech = probabilityModel(a, b, params, 1, 1).pWin;
      const pLowTech  = probabilityModel({ ...a, tech: 5 }, { ...b, tech: 9 }, params, 1, 1).pWin;
      tests.push({ name: "Higher technique ↑ P(win)", passed: pHighTech > pLowTech, info: `Δtech=+4: p0=${pLowTech.toFixed(3)} → p1${pHighTech.toFixed(3)},` });
    }

    return tests;
  }

  const testResults = useMemo(runTests, [alpha, gamma, weightImportance, drawBase, drawDecay, drawCap, skillKg, skillSlope, streakPenalty]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <h1 className="text-2xl font-bold">Quintet Lineup Optimizer</h1>
      <p className="text-sm text-gray-600">
        Win chance = logistic(x) of a scaled, nonlinear advantage (weightImportance, gamma) plus a bias for technique;
        draws shrink with drawDecay from drawBase up to drawCap. Condition and Tech are 1–10. Fatigue from consecutive fights is penalized too.
        Look at the sanity check in the bottom to figure out if the Deltas match up with your expected win probability variations.
      </p>

      {/* Rosters + Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          <RosterEditor team={ourTeam} setTeam={setOurTeam} title="Our Team" />
          <RosterEditor team={oppTeam} setTeam={setOppTeam} title="Opponent Team" />
        </div>
        <div className="space-y-4">
          {/* Model Parameters Panel */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="font-semibold mb-2">Model parameters</h3>
            <TextInput label="Weight importance" value={weightImportance} onChange={setWeightImportance} step={0.01} min={0} help="Multiplier converting kg diff to prob units." />
            <TextInput label="Nonlinearity exponent (gamma)" value={gamma} onChange={setGamma} step={0.05} min={0.5} help=">1 makes big edges disproportionately strong." />
            <TextInput label="Logistic slope (alpha)" value={alpha} onChange={setAlpha} step={0.05} min={0.1} help="How sharply advantage converts to win chance." />
            <TextInput label="Draw base" value={drawBase} onChange={setDrawBase} step={0.01} min={0} max={0.99} help="Draw chance when matchups are even." />
            <TextInput label="Draw decay" value={drawDecay} onChange={setDrawDecay} step={0.05} min={0} help="Higher = draws vanish faster as advantage grows." />
            <TextInput label="Draw cap" value={drawCap} onChange={setDrawCap} step={0.01} min={0} max={0.99} help="Upper bound on draw probability." />
            <TextInput label="Skill kg per TECH point" value={skillKg} onChange={setSkillKg} step={0.5} min={0} help="How many kg of edge each TECH point is worth." />
            <TextInput label="Skill slope" value={skillSlope} onChange={setSkillSlope} step={0.1} min={0} help="Multiplier on the technical bias in logistic input." />
            <TextInput label="Streak penalty (per extra fight)" value={streakPenalty} onChange={setStreakPenalty} step={0.01} min={0} max={0.2} help="Per additional consecutive fight, reduce effective condition by this fraction (e.g., 0.08 = 8%)." />
          </div>
          {/* Opponent-order model mode */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="font-semibold mb-2">Opponent-order assumption</h3>
            <select className="w-full border rounded-xl p-2" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="exploit">Exploitative: max EV vs current opponent order</option>
              <option value="robust">Robust: max our worst-case EV (opponent picks their best order)</option>
            </select>
          </div>
          <ProbPreview />
        </div>
      </div>

      {/* Recommendation + Best Response */}
      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Recommended Order</h3>
        {bestOurOrderIdxs.length > 0 ? (
          <div className="space-y-2">
            <OrderBadge label={`Our optimal order (${mode}) — EV net wins: ${result.best.ev.toFixed(3)}`} team={ourTeam} orderIdxs={bestOurOrderIdxs} />
            {oppBestResponse && (
              <OrderBadge label = {`Assuming opponent best response — EV: ${oppBestResponse.ev.toFixed(3)}`}  team={oppTeam} orderIdxs={oppBestResponse.order} />
            )}
          </div>
        ) : (
          <div>No result.</div>
        )}
      </div>

      {/* Top 5 Our Orders */}
      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Top 5 Our Orders (by EV)</h3>
        <div className="space-y-2">
          {result.top.map((row, i) => (
            <div key={i} className="border rounded-xl p-3">
              <div className="text-sm text-gray-600">EV net wins: {row.ev.toFixed(3)}</div>
              <ol className="flex flex-wrap gap-2 mt-1">
                {row.order.map((idx, k) => (
                  <li key={k} className="px-3 py-1 rounded-full bg-gray-100 border">{ourTeam[idx].name}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      {/* Best orders with each player first */}
      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Best Orders with Each Player First</h3>
        <div className="space-y-2">
          {forcedFirst.map((row, i) => (
            <div key={i} className="border rounded-xl p-3">
              <div className="text-sm text-gray-600">{ourTeam[row.first].name} first — EV net wins: {row.ev.toFixed(3)}</div>
              <ol className="flex flex-wrap gap-2 mt-1">
                {row.order.map((idx, k) => (
                  <li key={k} className="px-3 py-1 rounded-full bg-gray-100 border">{ourTeam[idx].name}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      {/* Diagnostics & Tests */}
      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Diagnostics & Tests</h3>
        <ul className="list-disc pl-5 space-y-1">
          {testResults.map((t, i) => (
            <li key={i} className={t.passed ? "text-green-700" : "text-red-700"}>
              <span className="font-medium">{t.passed ? "✔" : "✘"} {t.name}:</span> <span className="ml-1 text-gray-700">{t.info}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Footnote / sanity notes */}
      <div className="text-xs text-gray-500">
        Condition maps to ~0.85–1.15 on weight; technique adds ≈ (skillKg × weightImportance) per point in normalized units.
        The markov chain explores every win/lose/draw branch for any two orders via brute "enumeration".
      </div>
    </div>
  );
}
