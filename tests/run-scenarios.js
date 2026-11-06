#!/usr/bin/env node
/*
 * Headless regression tests for the simulation core (no browser needed).
 * Loads the <script id="sim-core"> block from index.html and flies scripted scenarios.
 *
 *   node tests/run-scenarios.js
 *
 * Exit code 0 = all checks passed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const core = html.match(/<script id="sim-core">([\s\S]*?)<\/script>/)[1];
const makeSim = () => new Function(core + ';return Sim;')();
const DT = 1 / 250;

let failures = 0;
function check(name, ok, detail){
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// Fly ARM → TAKEOFF → MISSION and let the mission end action (RTL by default) bring the drone home.
function flyRoute(setup, opts = {}){
  const Sim = makeSim();
  Sim.params.drain = 1;
  setup(Sim);
  const events = [];
  Sim.on(e => events.push(e));
  let step = 0, minClear = 99, maxT = opts.maxT || 600;
  for (let i = 0; i < maxT / DT; i++){
    const S = Sim.S, st = S.state;
    if (step === 0){ Sim.command('ARM'); step = 1; }
    else if (step === 1 && st === 'ARMED' && S.stateT > 0.9){ Sim.command('TAKEOFF'); step = 2; }
    else if (step === 2 && st === 'HOVER' && S.stateT > 1.0){ Sim.command('MISSION'); step = 3; }
    if (opts.during) opts.during(Sim, S.t);
    Sim.step(DT);
    if (!S.grounded && S.pos[2] > 0.5) minClear = Math.min(minClear, S.minObsDist);
    if (step === 3 && (st === 'ARMED' || st === 'DISARMED' || st === 'EMERGENCY') && S.stateT > 0.5) break;
  }
  const S = Sim.S;
  return {
    Sim, S, events, minClear,
    crashed: events.some(e => e.type === 'transition' && e.to === 'EMERGENCY'),
    home: Math.hypot(S.pos[0], S.pos[1]) < 1.0 && S.grounded,
    delivered: events.filter(e => e.type === 'delivery').length,
  };
}

const H = makeSim().HUBS;
const hub = c => ({ e: H[c].e, n: H[c].n, u: 12, label: 'Hub ' + c });

// 1. Each hub and the multi-hub route, default settings
for (const [name, list] of [['Hub A', ['A']], ['Hub B', ['B']], ['Hub C', ['C']], ['Liên trạm A→B→C', ['A', 'B', 'C']]]){
  const r = flyRoute(Sim => Sim.setDestinations(list.map(hub), true), { maxT: 900 });
  check(`${name}: giao đủ ${list.length} trạm, về Nhà máy, không va chạm`,
    !r.crashed && r.home && r.delivered === list.length,
    `cách tường gần nhất ${r.minClear.toFixed(2)} m, đã giao ${r.delivered}`);
}

// 2. High speed (14 m/s): corner speed scheduling must keep the drone off the facades
{
  const r = flyRoute(Sim => { Sim.params.vMax = 14; Sim.setDestinations(['A', 'B', 'C'].map(hub), true); }, { maxT: 900 });
  check('Tốc độ tối đa 14 m/s: không văng khỏi góc cua', !r.crashed && r.home, `cách tường gần nhất ${r.minClear.toFixed(2)} m`);
}

// 3. HOLD in the middle of a multi-hub route, then MISSION again: must resume at the next hub
{
  let held = false, resumed = false;
  const r = flyRoute(Sim => Sim.setDestinations(['A', 'B', 'C'].map(hub), true), {
    maxT: 900,
    during(Sim, t){
      const S = Sim.S;
      if (!held && S.destDone === 1 && S.state === 'MISSION'){ Sim.command('HOLD'); held = true; }
      else if (held && !resumed && S.state === 'HOVER' && S.stateT > 2){ Sim.command('MISSION'); resumed = true; }
    }
  });
  const order = r.events.filter(e => e.type === 'delivery').map(e => e.msg.match(/Hub [ABC]/)[0]).join(' → ');
  check('HOLD giữa tuyến rồi MISSION: bay tiếp đúng trạm kế tiếp', !r.crashed && r.home && order === 'Hub A → Hub B → Hub C', order);
}

// 4. Link loss on the way to Hub C → FAILSAFE flies the planned route home and lands
{
  let cut = false;
  const r = flyRoute(Sim => Sim.setDestinations([hub('C')], true), {
    during(Sim, t){ if (!cut && t > 20){ Sim.setLink(true); cut = true; } }
  });
  check('Mất liên kết: FAILSAFE né cao ốc về Nhà máy và hạ cánh',
    !r.crashed && r.home && r.events.some(e => e.to === 'FAILSAFE'), `cách tường gần nhất ${r.minClear.toFixed(2)} m`);
}

// 5. Cargo is split evenly over a multi-hub route
{
  const r = flyRoute(Sim => Sim.setDestinations(['A', 'B', 'C'].map(hub), true), { maxT: 900 });
  const drops = r.events.filter(e => e.type === 'delivery').map(e => parseFloat(e.msg.match(/thả ([\d.]+) kg/)[1]));
  check('Chia hàng đều cho các trạm (1,5 kg / 3)', drops.length === 3 && drops.every(d => Math.abs(d - 0.5) < 0.01), drops.join(', ') + ' kg');
}

// 6. Planner: random click targets never produce a path through a building
{
  const Sim = makeSim();
  let seed = 7, worst = 99, total = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i++){
    const t0 = Date.now();
    Sim.setDestinations([{ e: (rnd() - 0.5) * 150, n: (rnd() - 0.5) * 150, u: 12 }], true);
    total += Date.now() - t0;
    const pts = [Sim.missionStart].concat(Sim.mission);
    for (let k = 1; k < pts.length; k++){
      const a = pts[k - 1], b = pts[k], u = Math.min(a.u, b.u);
      const N = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / 0.5));
      for (let s = 0; s <= N; s++) worst = Math.min(worst, Sim.clearanceAt(a.e + (b.e - a.e) * s / N, a.n + (b.n - a.n) * s / N, u).d);
    }
  }
  check('A*: 200 điểm click ngẫu nhiên, đường bay cách tường ≥ 1,6 m', worst >= 1.6 - 1e-6,
    `nhỏ nhất ${worst.toFixed(2)} m, trung bình ${(total / 200).toFixed(1)} ms/lần lập tuyến`);
}

// 7. Cruising above every roof needs no detour
{
  const Sim = makeSim();
  Sim.params.takeoffAlt = 36;
  const r = Sim.setDestinations([{ e: H.A.e, n: H.A.n, u: 36 }], true);
  check('Bay ở 36 m (trên mọi nóc nhà): đường thẳng, không cần điểm né', r.avoidCount === 0);
}

// 8. Adaptive control: hover through wind and payload steps, compare with fixed-gain PID
function hoverSteps(adaptive){
  const Sim = makeSim(); const P = Sim.params;
  Object.assign(P, { drain:1, windOn:true, windSpeed:4, windDir:270, gust:0, adaptive });
  const run = (sec, cb) => { for (let i = 0; i < sec / DT; i++){ Sim.step(DT); if (cb) cb(Sim.S); } };
  Sim.command('ARM'); run(1); Sim.command('TAKEOFF'); run(9);
  const out = { drift:0, alt:0, leanErr:0, mErr:[] };
  const track = S => { out.drift = Math.max(out.drift, Math.hypot(S.pos[0] - S.hold[0], S.pos[1] - S.hold[1])); out.alt = Math.max(out.alt, Math.abs(S.pos[2] - S.hold[2])); };
  const steps = [() => { P.windDir = 180; }, () => { P.windSpeed = 9; }, () => { P.cargoMass = 0.5; }, () => { P.cargoMass = 0; }];
  for (const st of steps){
    st(); run(14, track);
    const S = Sim.S, Fd = (Sim.P.kd + Sim.P.kq * S.windSpd) * S.windSpd;
    const theory = Math.atan(Fd / (Sim.P.m * Sim.P.g)) * 180 / Math.PI;
    const lean = Math.acos(Math.cos(S.att[0]) * Math.cos(S.att[1])) * 180 / Math.PI;
    out.leanErr = Math.max(out.leanErr, Math.abs(lean - theory));
    out.mErr.push(Math.abs(S.est.mHat - Sim.P.m));
  }
  return out;
}
{
  const on = hoverSteps(true), off = hoverSteps(false);
  check('Thích nghi: góc nghiêng giữ vị trí khớp lý thuyết atan(cản/(m·g))', on.leanErr < 0.5, `sai lệch lớn nhất ${on.leanErr.toFixed(2)}°`);
  check('Thích nghi: m̂ hội tụ về khối lượng thật sau mỗi lần thả hàng', Math.max(...on.mErr) < 0.05, `sai số m̂ ${on.mErr.map(v => v.toFixed(3)).join(', ')} kg`);
  check('Thích nghi giữ vị trí tốt hơn PID cố định', on.drift < off.drift && on.alt < off.alt,
    `lệch ngang ${on.drift.toFixed(2)} vs ${off.drift.toFixed(2)} m · lệch cao ${on.alt.toFixed(2)} vs ${off.alt.toFixed(2)} m`);
}

// 9. Wind × payload sweep (the "Kết quả" panel): the physical trends must hold
{
  const sweepSrc = html.match(/<script id="sweep-core">([\s\S]*?)<\/script>/)[1];
  const { SWEEP, sweepCase, sweepPlan } = new Function(sweepSrc + ';return { SWEEP, sweepCase, sweepPlan };')();
  const t0 = Date.now();
  const res = sweepPlan().map(o => sweepCase(makeSim, o));
  const g = (p, w) => res.find(r => r.kind === 'steady' && r.payload === p && r.wind === w);
  const incWind = SWEEP.payloads.every(p => SWEEP.winds.every((w, i) => i === 0 || g(p, w).lean > g(p, SWEEP.winds[i - 1]).lean));
  const decLoad = SWEEP.winds.slice(1).every(w => SWEEP.payloads.every((p, i) => i === 0 || g(p, w).lean < g(SWEEP.payloads[i - 1], w).lean));
  check('Kết quả: gió mạnh hơn → nghiêng nhiều hơn; tải nặng hơn → nghiêng ít hơn', incWind && decLoad,
    `1,5 kg: ${SWEEP.winds.map(w => g(1.5, w).lean.toFixed(1)).join(' → ')}° · gió 12: ${SWEEP.payloads.map(p => g(p, 12).lean.toFixed(1)).join(' → ')}°`);
  const end = SWEEP.payloads.map(p => g(p, 0).endurance);
  check('Kết quả: tải nặng hơn → thời gian bay ngắn hơn', end.every((v, i) => i === 0 || v < end[i - 1]), end.map(v => v.toFixed(1)).join(' → ') + ' phút');
  const stepA = res.filter(r => r.kind === 'windStep' && r.adaptive), stepF = res.filter(r => r.kind === 'windStep' && !r.adaptive);
  const dropA = res.filter(r => r.kind === 'drop' && r.adaptive), dropF = res.filter(r => r.kind === 'drop' && !r.adaptive);
  check('Kết quả: thích nghi lệch ít hơn PID cố định ở mọi mức tải', stepA.every((r, i) => r.peak < stepF[i].peak) && dropA.every((r, i) => r.peak < dropF[i].peak),
    `gió tăng vọt ${stepA.map(r => r.peak.toFixed(2)).join('/')} vs ${stepF.map(r => r.peak.toFixed(2)).join('/')} m · thả hàng ${dropA.map(r => r.peak.toFixed(2)).join('/')} vs ${dropF.map(r => r.peak.toFixed(2)).join('/')} m · ${res.length} chuyến trong ${Date.now() - t0} ms`);
}

console.log(failures ? `\n${failures} kiểm tra thất bại` : '\nTất cả kiểm tra đều đạt');
process.exit(failures ? 1 : 0);
