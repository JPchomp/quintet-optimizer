import React, { useMemo, useState } from "react";

/**
 * ------------------------------------------------------------
 * QUINTET LINEUP OPTIMIZER (Submission-only, Winner-stays)
 * ------------------------------------------------------------
 * Probability model: three deltas (weight, condition, technique).
 * Each delta has its own exponent (nonlinearity) and multiplier (importance).
 * No per-factor scales; the multipliers set relative importance directly.
 * Draw probability PD is bounded with a floor of 0.2 and PD(0) = user-set PD0.
 * PD decays with |S| via a fixed tanh curve (no extra params).
 * Winner-stays fatigue reduces CONDITION only before computing its delta.
 */

// ============================================================
// =                         UTILITIES                        =
// ============================================================
function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

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
function defaultTeam(namePrefix) {
  return [
    { name: "JP",     weight: 62,  condition: 10, tech: 10 },
    { name: "FLORIS", weight: 67,  condition: 10, tech: 10 },
    { name: "ALEX",   weight: 79,  condition: 10, tech: 10 },
    { name: "NIELS",  weight: 87,  condition: 10, tech: 10 },
    { name: "NOAH",   weight: 122, condition: 10, tech: 10 },
  ];
}

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
 * fatigueFactor(streak, streakPenalty)
 * Linear penalty per extra consecutive fight for the SAME athlete.
 * streak = 1 → 1.0, 2 → 1 - p, 3 → 1 - 2p, clipped to [0.7, 1].
 */
function fatigueFactor(streak, streakPenalty) {
  const extra = Math.max(0, streak - 1);
  return clamp(1 - streakPenalty * extra, 0.7, 1);
}

/**
 * scoreFromDelta(delta, gamma, alpha)
 * Signed, nonlinear contribution: sign(delta)*|delta|^gamma scaled by alpha.
 */
function scoreFromDelta(delta, gamma, alpha) {
  if (!alpha) return 0;
  const mag = Math.pow(Math.abs(delta), gamma);
  const signed = Math.sign(delta) * mag;
  return alpha * signed;
}

/**
 * probabilityModel(a, b, params, streakA, streakB)
 * Three-delta model with bounded draw and soft split of residual mass.
 * Returns { pWin, pDraw, pLose, S, deltas }
 */
function probabilityModel(a, b, params, streakA = 1, streakB = 1) {
  // Effective CONDITION after fatigue (winner-stays effect applies to condition only)
  const effCondA = (a.condition ?? 5) * fatigueFactor(streakA, params.streakPenalty);
  const effCondB = (b.condition ?? 5) * fatigueFactor(streakB, params.streakPenalty);

  // Raw deltas (units: kg, cond points, tech points)
  const dw = (a.weight ?? 0) - (b.weight ?? 0);
  const dc = effCondA - effCondB;
  const dt = (a.tech ?? 5) - (b.tech ?? 5);

  // Component scores without any per-factor scaling
  const Sw = scoreFromDelta(dw, params.wGamma, params.wAlpha);
  const Sc = scoreFromDelta(dc, params.cGamma, params.cAlpha);
  const St = scoreFromDelta(dt, params.tGamma, params.tAlpha);

  // Total advantage score
  const S = Sw + Sc + St; // sign favors A when positive
  const A = Math.abs(S);

  // Draw probability: floor 0.2, baseline PD0 at S=0, decay with |S| via tanh
  const PD0 = clamp(params.drawBase0, 0.2, 0.95); // keep sane
  const PD = Math.max(0.2, PD0 - 0.5 * Math.tanh(A));
  const M = 1 - PD;

  // Split remaining mass with softness k, h in [0, 0.5)
  const h = 0.5 * (A / (A + params.splitK));
  let PW = S >= 0 ? M * (0.5 + h) : M * (0.5 - h);
  let PL = M - PW;

  // Clamp and renormalize for safety
  PW = clamp(PW, 0, 1);
  const pD = clamp(PD, 0, 1);
  PL = clamp(PL, 0, 1);
  const sum = PW + pD + PL;
  return { pWin: PW / sum, pDraw: pD / sum, pLose: PL / sum, S, deltas: { dw, dc, dt } };
}

// ============================================================
// =          DYNAMIC PROGRAMMING (ALL OUTCOME PATHS)         =
// ============================================================
function expectedNetWins(our, opp, params) {
  const n = our.length;
  const m = opp.length;
  const memo = new Map();
  const key = (i, j, si, sj) => `${i},${j},${si},${sj}`;
  function f(i, j, si, sj) {
    if (i >= n || j >= m) return 0;
    const k = key(i, j, si, sj);
    if (memo.has(k)) return memo.get(k);
    const { pWin, pDraw, pLose } = probabilityModel(our[i], opp[j], params, si, sj);
    const val = pWin * (1 + f(i, j + 1, si + 1, 1)) + pLose * (-1 + f(i + 1, j, 1, sj + 1)) + pDraw * (0 + f(i + 1, j + 1, 1, 1));
    memo.set(k, val);
    return val;
  }
  return f(0, 0, 1, 1);
}

// ============================================================
// =                 SEARCH OUR LINEUP ORDERS                 =
// ============================================================
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
export default function App() {
  // Teams
  const [ourTeam, setOurTeam] = useState(defaultTeam("Our"));
  const [oppTeam, setOppTeam] = useState(defaultTeamOthers("Opp"));

  // Model knobs — multipliers and exponents only; PD0 for draws; split softness; fatigue
  const [wGamma, setWGamma] = useState(0.5);
  const [cGamma, setCGamma] = useState(0.5);
  const [tGamma, setTGamma] = useState(0.5);

  // 
  const [wAlpha, setWAlpha] = useState(1.0);
  const [cAlpha, setCAlpha] = useState(1.0);
  const [tAlpha, setTAlpha] = useState(1.0);

  const [drawBase0, setDrawBase0] = useState(0.50); // PD(0)
  const [splitK, setSplitK] = useState(2.0);        // softness for win/loss split
  const [streakPenalty, setStreakPenalty] = useState(0.1); // per extra consecutive fight
  const [mode, setMode] = useState("exploit");

  const params = { wGamma, wAlpha, cGamma, cAlpha, tGamma, tAlpha, drawBase0, splitK, streakPenalty };

  // Optimization
  const result = useMemo(() => {
    if (mode === "exploit") return optimizeOurOrder(ourTeam, oppTeam, params);
    return robustOurOrder(ourTeam, oppTeam, params);
  }, [ourTeam, oppTeam, wGamma, wAlpha, cGamma, cAlpha, tGamma, tAlpha, drawBase0, splitK, streakPenalty, mode]);

  const bestOurOrderIdxs = result?.best?.order || [];
  const bestOurOrder = bestOurOrderIdxs.map((i) => ourTeam[i]);

  const oppBestResponse = useMemo(() => {
    if (bestOurOrder.length === 0) return null;
    return pickOppBestOrderAgainst(bestOurOrder, oppTeam, params);
  }, [bestOurOrder, oppTeam, params]);

  // Preview components
  function OrderBadge({ label, team, orderIdxs }) {
    return (
      <div className="rounded-2xl border p-3">
        <div className="font-semibold mb-2">{label}</div>
        <ol className="flex flex-wrap gap-2">
          {orderIdxs.map((idx, k) => (
            <li key={k} className="px-3 py-1 rounded-full bg-gray-100 border">{team[idx].name}</li>
          ))}
        </ol>
      </div>
    );
  }

  const ProbPreview = () => {
    const a = ourTeam[0];
    const b = oppTeam[0];
    const { pWin, pDraw, pLose, S, deltas } = probabilityModel(a, b, params, 1, 1);
    return (
      <div className="rounded-2xl border p-3">
        <div className="font-semibold mb-2">Probability model preview (Our[1] vs Opp[1])</div>
        <div className="text-sm">Score S: {S.toFixed(3)} | Δw: {deltas.dw.toFixed(1)} kg, Δc: {deltas.dc.toFixed(2)}, Δt: {deltas.dt.toFixed(2)}</div>
        <div className="text-sm">W { (pWin*100).toFixed(1) }% | D { (pDraw*100).toFixed(1) }% | L { (pLose*100).toFixed(1) }%</div>
      </div>
    );
  };

  const ProbMatrix = () => (
    <div className="bg-white rounded-2xl shadow p-4">
      <h3 className="font-semibold mb-2">Matchup probabilities (fresh)</h3>
      <div className="overflow-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="border p-2">Our \\ Opp</th>
              {oppTeam.map((p, j) => (
                <th key={j} className="border p-2 text-sm">{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ourTeam.map((a, i) => (
              <tr key={i}>
                <th className="border p-2 text-sm text-left">{a.name}</th>
                {oppTeam.map((b, j) => {
                  const { pWin, pDraw, pLose } = probabilityModel(a, b, params, 1, 1);
                  return (
                    <td key={j} className="border p-2 text-xs text-center">
                      W {(pWin * 100).toFixed(0)}%<br />
                      D {(pDraw * 100).toFixed(0)}%<br />
                      L {(pLose * 100).toFixed(0)}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  // Diagnostics & Tests
  function runTests() {
    const tests = [];

    // Sum to ~1
    {
      const a = { weight: 100, condition: 8, tech: 7 };
      const b = { weight: 100, condition: 8, tech: 7 };
      const { pWin, pDraw, pLose } = probabilityModel(a, b, params, 1, 1);
      const sum = pWin + pDraw + pLose;
      tests.push({ name: "Probabilities sum to 1", passed: Math.abs(sum - 1) < 1e-9, info: `sum=${sum.toFixed(6)}` });
    }

    // Baseline PD(0)=drawBase0, PW=PL=(1-PD0)/2
    {
      const a = { weight: 90, condition: 5, tech: 5 };
      const b = { weight: 90, condition: 5, tech: 5 };
      const { pWin, pDraw, pLose } = probabilityModel(a, b, params, 1, 1);
      const PD0 = clamp(drawBase0, 0.2, 0.95);
      const target = (1 - PD0) / 2;
      tests.push({ name: "Zero deltas baseline", passed: Math.abs(pDraw - PD0) < 1e-6 && Math.abs(pWin - target) < 1e-3, info: `W=${(pWin*100).toFixed(1)} D=${(pDraw*100).toFixed(1)} L=${(pLose*100).toFixed(1)} (PD0=${(PD0*100).toFixed(1)})` });
    }

    // Draw never below 0.2
    {
      const a = { weight: 140, condition: 10, tech: 10 };
      const b = { weight: 60,  condition: 1,  tech: 1 };
      const { pDraw } = probabilityModel(a, b, params, 1, 1);
      tests.push({ name: "Draw floor 0.2", passed: pDraw >= 0.2 - 1e-9, info: `pD=${pDraw.toFixed(3)}` });
    }

    // Monotonicity checks
    {
      const baseA = { weight: 90, condition: 8, tech: 7 };
      const baseB = { weight: 90, condition: 8, tech: 7 };
      const p0 = probabilityModel(baseA, baseB, params, 1, 1).pWin;
      const pW = probabilityModel({ ...baseA, weight: 100 }, baseB, params, 1, 1).pWin;
      const pC = probabilityModel({ ...baseA, condition: 10 }, baseB, params, 1, 1).pWin;
      const pT = probabilityModel({ ...baseA, tech: 10 }, baseB, params, 1, 1).pWin;
      tests.push({ name: "Heavier ↑ P(win)", passed: pW > p0, info: `p0=${p0.toFixed(3)} → pW=${pW.toFixed(3)}` });
      tests.push({ name: "Condition ↑ P(win)", passed: pC > p0, info: `p0=${p0.toFixed(3)} → pC=${pC.toFixed(3)}` });
      tests.push({ name: "Technique ↑ P(win)", passed: pT > p0, info: `p0=${p0.toFixed(3)} → pT=${pT.toFixed(3)}` });
    }

    // Fatigue reduces win chance (conditional on no-draw to avoid PD side-effects)
    {
      const a = { weight: 90, condition: 8, tech: 7 };
      const b = { weight: 90, condition: 8, tech: 7 };
      const freshRes = probabilityModel(a, b, params, 1, 1);
      const tiredRes = probabilityModel(a, b, params, 3, 1);
      const fresh = freshRes.pWin;
      const tired = tiredRes.pWin;
      const freshShare = fresh / (1 - freshRes.pDraw);
      const tiredShare  = tired  / (1 - tiredRes.pDraw);
      const passed = tiredShare < freshShare - 1e-9;
      tests.push({ name: "Fatigue reduces P(win | not draw)", passed, info: `fresh=${fresh.toFixed(3)} (share=${freshShare.toFixed(3)}) tired=${tired.toFixed(3)} (share=${tiredShare.toFixed(3)})` });
    }

    // Antisymmetry sanity: EV(our, opp) ≈ -EV(opp, our) in a simple 1v1
    {
      const A = [{ name: "A", weight: 95, condition: 7, tech: 7 }];
      const B = [{ name: "B", weight: 85, condition: 7, tech: 7 }];
      const evAB = expectedNetWins(A, B, params);
      const evBA = expectedNetWins(B, A, params);
      const passed = Math.abs(evAB + evBA) < 1e-9;
      tests.push({ name: "EV antisymmetry (1v1)", passed, info: `evAB=${evAB.toFixed(6)} evBA=${evBA.toFixed(6)}` });
    }

    return tests;
  }

  const testResults = useMemo(runTests, [wGamma, wAlpha, cGamma, cAlpha, tGamma, tAlpha, drawBase0, splitK, streakPenalty]);

  // Totals
  const oppTotal = oppTeam.reduce((s, p) => s + (Number(p.weight) || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Quintet Lineup Optimizer</h1>
      <p className="text-sm text-gray-600">
        Simple three-delta model with multipliers (importance) and exponents (nonlinearity). Draw uses a PD(0) baseline, never drops below 0.2, and decays with |S|.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          <RosterEditor team={ourTeam} setTeam={setOurTeam} title="Our Team" />
          <RosterEditor team={oppTeam} setTeam={setOppTeam} title={`Opponent Team (total: ${oppTotal.toFixed(1)} kg)`} />
        </div>
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="font-semibold mb-2">Model parameters</h3>
            <TextInput label="Weight exponent (γw)" value={wGamma} onChange={setWGamma} step={0.1} min={0.5} help="Nonlinearity for weight delta" />
            <TextInput label="Weight multiplier (αw)" value={wAlpha} onChange={setWAlpha} step={0.1} min={0} help="Importance of weight" />

            <TextInput label="Condition exponent (γc)" value={cGamma} onChange={setCGamma} step={0.1} min={0.5} help="Nonlinearity for condition delta" />
            <TextInput label="Condition multiplier (αc)" value={cAlpha} onChange={setCAlpha} step={0.1} min={0} help="Importance of condition" />

            <TextInput label="Technique exponent (γt)" value={tGamma} onChange={setTGamma} step={0.1} min={0.5} help="Nonlinearity for technique delta" />
            <TextInput label="Technique multiplier (αt)" value={tAlpha} onChange={setTAlpha} step={0.1} min={0} help="Importance of technique" />

            <TextInput label="Draw PD(0) baseline" value={drawBase0} onChange={setDrawBase0} step={0.01} min={0.2} max={0.95} help="Draw at equal matchups. Floor is 0.2." />
            <TextInput label="Split softness (k)" value={splitK} onChange={setSplitK} step={0.1} min={0.1} help="Higher = slower shift from 50/50 of non-draw mass" />
            <TextInput label="Streak penalty / extra fight" value={streakPenalty} onChange={setStreakPenalty} step={0.01} min={0} max={0.2} help="Reduces effective condition for consecutive bouts" />
          </div>
          <div className="bg-white rounded-2xl shadow p-4">
            <h3 className="font-semibold mb-2">Opponent-order assumption</h3>
            <select className="w-full border rounded-xl p-2" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="exploit">Exploitative: maximize EV vs current opponent order</option>
              <option value="robust">Robust: maximize our worst-case EV</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Recommended Order</h3>
        {bestOurOrderIdxs.length > 0 ? (
          <div className="space-y-2">
            <OrderBadge label={`Our optimal order (${mode}) — EV net wins: ${result.best.ev.toFixed(3)}`} team={ourTeam} orderIdxs={bestOurOrderIdxs} />
            {oppBestResponse && (
              <OrderBadge label={`Assuming opponent best response — OUR EV vs that: ${oppBestResponse.ev.toFixed(3)}`} team={oppTeam} orderIdxs={oppBestResponse.order} />
            )}
          </div>
        ) : (
          <div>No result.</div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Top 5 Our Orders (by EV)</h3>
        <div className="space-y-2">
          {result.top.map((row, i) => (
            <div key={i} className="border rounded-2xl p-3">
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

      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="font-semibold mb-3">Best Orders with Each Player First</h3>
        <div className="space-y-2">
          {ourTeam.map((_, i) => {
            const res = mode === "robust" ? robustOurOrderWithFirst(ourTeam, oppTeam, params, i) : optimizeOurOrderWithFirst(ourTeam, oppTeam, params, i);
            return (
              <div key={i} className="border rounded-xl p-3">
                <div className="text-sm text-gray-600">{ourTeam[i].name} first — EV net wins: {res.ev.toFixed(3)}</div>
                <ol className="flex flex-wrap gap-2 mt-1">
                  {res.order.map((idx, k) => (
                    <li key={k} className="px-3 py-1 rounded-full bg-gray-100 border">{ourTeam[idx].name}</li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      </div>

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

      <ProbMatrix />

      <div className="text-xs text-gray-500 space-y-1">
        <div><span className="font-semibold">Probability model:</span> S = αw·sign(Δw)|Δw|^γw + αc·sign(Δc)|Δc|^γc + αt·sign(Δt)|Δt|^γt. Positive S favors us.</div>
        <div>Draw PD = max(0.2, PD(0) − 0.5·tanh(|S|)). Remaining mass splits to win/loss by h = 0.5·|S|/(|S|+k).</div>
        <div>Fatigue only reduces condition via a linear penalty per consecutive bout, then deltas are recomputed.</div>
      </div>
    </div>
  );
}
