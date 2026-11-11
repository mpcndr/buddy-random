import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, remove, runTransaction } from "firebase/database";

function getRoomId() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get("room");
  if (!room) {
    room = Math.random().toString(36).slice(2, 10);
    url.searchParams.set("room", room);
    window.history.replaceState(null, "", url.toString());
  }
  return room;
}

const ROOM_ID = getRoomId();
const ME_KEY = `lucky_me_v1_${ROOM_ID}`;
const RULES_KEY = `lucky_rules_v1_${ROOM_ID}`;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const roomRef = ref(db, `rooms/${ROOM_ID}`);

const SHAKE_MS = 2600; // ช่วงเขย่ากระบอก
const DROP_MS = 1100; // ช่วงไม้เซียมซีหล่นออกมา
const MIN_PLAYERS = 2;
const WIGGLE_MS = 300; // ความยาว 1 จังหวะของท่าเขย่า (ต้องตรงกับใน CSS)
const RULES_LOCK_MS = 4000; // ต้องเปิดกติกาค้างไว้อย่างน้อยเท่านี้ก่อนปิดได้
const REROLL_WAIT_MS = 15000; // หัวห้องต้องรอเท่านี้ก่อนกดสุ่มคนเขย่าใหม่ได้ (กันกดเล่น)

/*
 * โครงข้อมูลห้อง rooms/{room}
 *   players:   [{ id, name }]         ลำดับที่เข้าห้อง (ใช้เป็นเบอร์ไม้)
 *   hostId:    id ของหัวห้อง (คนแรกที่ลงชื่อ)
 *   started:   true เมื่อหัวห้องกดเริ่มเกม (หลังจากนั้นเข้าห้องเพิ่มไม่ได้)
 *   turnId:    id ของคนที่ถูกสุ่มให้เขย่าตอนนี้ (หน้าจอแสดงให้เจ้าตัวเห็นคนเดียว)
 *   shakenIds: { [id]: true }        คนที่เขย่าไปแล้ว (คนละครั้งเดียว)
 *   draws:     [{ id, winnerId, byId, stickNo, at }]
 *              stickNo สุ่มใหม่ทุกครั้ง ไม่เกี่ยวกับลำดับชื่อ (เดาไม่ได้ว่าเป็นใคร)
 *              ชื่อที่จับได้ หน้าจอโชว์ให้คนเขย่า (byId) เห็นคนเดียว
 */

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function loadMe() {
  try {
    const raw = storageGet(ME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const saveMe = (me) => storageSet(ME_KEY, JSON.stringify(me));
const clearMe = () => storageRemove(ME_KEY);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

const rulesRead = storageGet(RULES_KEY) === "1";

const state = {
  round: null,
  me: loadMe(),
  loading: true,
  name: "",
  error: "",
  claim: null,
  busy: false,
  confirm: null, // null | "restart" | "room"
  copied: false,
  pendingShakeAt: null, // เวลาที่เรากดเขย่าเอง (ระหว่างรอผลจาก Firebase)
  motionOn: false,
  rulesOpen: !rulesRead,
  rulesUnlockAt: rulesRead ? 0 : Date.now() + RULES_LOCK_MS,
};

// drawId -> เวลาบนเครื่องนี้ที่เริ่มเล่นแอนิเมชันของการสุ่มครั้งนั้น
// (ใช้เวลาเครื่องตัวเอง ไม่ใช้เวลาจากเครื่องคนกด กันนาฬิกาแต่ละเครื่องไม่ตรงกัน)
const seen = {};
let firstSnapshot = true;
let notifiedTurnKey = null;
let turnKey = null; // ตาปัจจุบัน: เปลี่ยนเมื่อมีคนเขย่าหรือหัวห้องสุ่มใหม่
let turnSeenAt = 0;

const root = document.getElementById("app");

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function later(ms) {
  setTimeout(render, Math.max(0, ms) + 20);
}

const getDraws = (round) => round?.draws ?? [];
const getPlayers = (round) => round?.players ?? [];
const getShaken = (round) => round?.shakenIds ?? {};
const getHostId = (round) => round?.hostId ?? getPlayers(round)[0]?.id ?? null;

// อ่าน draw ใหม่ ๆ ที่เข้ามา แล้วตั้งเวลาเริ่มแอนิเมชันให้แต่ละอัน
function ingest(data) {
  const draws = getDraws(data);
  const now = Date.now();
  let pending = state.pendingShakeAt;
  for (const d of draws) {
    if (seen[d.id] != null) continue;
    if (firstSnapshot) {
      seen[d.id] = 0; // ของเก่าก่อนเปิดหน้า แสดงผลเลยไม่ต้องเขย่า
      continue;
    }
    let start = now;
    if (pending != null && state.me && d.byId === state.me.id) {
      // เราเป็นคนเขย่าเอง: ต่อจากจังหวะที่เริ่มเขย่าไปแล้ว แต่ถ้ารอนานจนเกินช่วงเขย่า ให้ไม้หล่นทันที
      start = Math.max(pending, now - SHAKE_MS);
      pending = null;
    } else {
      vibrate([60, 40, 60, 40, 60, 40, 60]);
    }
    seen[d.id] = start;
    later(start + SHAKE_MS - now);
    later(start + SHAKE_MS + DROP_MS - now);
  }
  firstSnapshot = false;
  return pending;
}

// รับข้อมูลห้องแบบเรียลไทม์จาก Firebase
onValue(
  roomRef,
  (snapshot) => {
    const data = snapshot.val();
    let mine = state.me;
    if (mine) {
      const players = getPlayers(data);
      if (!players.some((p) => p.id === mine.id)) {
        const sameName = players.find((p) => p.name === mine.name);
        mine = sameName ? { id: sameName.id, name: sameName.name } : null;
        if (!mine) clearMe();
        else saveMe(mine);
      }
    }
    const pendingShakeAt = ingest(data);
    const key = data?.started && data.turnId ? `${data.turnId}|${getDraws(data).length}` : null;
    if (key !== turnKey) {
      turnKey = key;
      turnSeenAt = Date.now();
    }
    setState({ round: data, me: mine, loading: false, pendingShakeAt });
  },
  (err) => {
    console.error("onValue error:", err);
    setState({ loading: false, error: `อ่านข้อมูลไม่ได้: ${err.message}` });
  }
);

// สถานะของแอนิเมชันการสุ่มล่าสุด
function getPhase() {
  const draws = getDraws(state.round);
  const last = draws[draws.length - 1];
  const now = Date.now();
  if (state.pendingShakeAt != null) {
    return { phase: "shaking", elapsed: now - state.pendingShakeAt, last: null };
  }
  if (!last) return { phase: "idle", elapsed: 0, last: null };
  const elapsed = now - (seen[last.id] ?? 0);
  if (elapsed < SHAKE_MS) return { phase: "shaking", elapsed, last };
  if (elapsed < SHAKE_MS + DROP_MS) return { phase: "drop", elapsed, last };
  return { phase: "reveal", elapsed, last };
}

function isHost() {
  return !!state.me && getHostId(state.round) === state.me.id;
}

async function join() {
  const clean = state.name.trim().replace(/\s+/g, " ");
  if (!clean) return setState({ error: "ใส่ชื่อก่อนนะ" });
  if (clean.length > 20) return setState({ error: "ชื่อยาวไป ใช้ไม่เกิน 20 ตัวอักษร" });

  setState({ busy: true, error: "" });

  const myId = uid();
  let outcome = null;
  let dupPlayer = null;

  try {
    const result = await runTransaction(roomRef, (current) => {
      const data = current || { createdAt: Date.now() };
      const players = data.players ?? [];
      const dup = players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
      if (dup) {
        outcome = "duplicate";
        dupPlayer = dup;
        return; // abort, ไม่แก้ไขอะไร
      }
      if (data.started) {
        outcome = "started";
        return;
      }
      outcome = "ok";
      return {
        ...data,
        hostId: data.hostId ?? players[0]?.id ?? myId,
        players: [...players, { id: myId, name: clean }],
      };
    });

    if (outcome === "ok" && result.committed) {
      const mine = { id: myId, name: clean };
      saveMe(mine);
      setState({ me: mine, busy: false, name: "" });
    } else if (outcome === "duplicate") {
      setState({ claim: dupPlayer, busy: false });
    } else if (outcome === "started") {
      setState({ error: "เกมเริ่มไปแล้ว เข้าร่วมเพิ่มไม่ได้ ถ้าเคยลงชื่อไว้ ให้ใส่ชื่อเดิม", busy: false });
    } else {
      setState({ busy: false });
    }
  } catch (err) {
    console.error("join error:", err);
    setState({ error: `บันทึกไม่สำเร็จ: ${err.message}`, busy: false });
  }
}

// หัวห้องกดเริ่มเกม: ล็อกรายชื่อ แล้วสุ่มลับ ๆ ว่าใครได้เขย่าคนแรก
async function startGame() {
  if (!isHost()) return;
  setState({ busy: true, error: "" });
  let outcome = null;
  try {
    await runTransaction(roomRef, (current) => {
      const players = current?.players ?? [];
      if (!current || current.started) {
        outcome = "noop";
        return;
      }
      if (players.length < MIN_PLAYERS) {
        outcome = "few";
        return;
      }
      outcome = "ok";
      return { ...current, started: true, turnId: pickRandom(players).id, shakenIds: null, draws: null };
    });
    setState({ busy: false, error: outcome === "few" ? `ต้องมีอย่างน้อย ${MIN_PLAYERS} คนก่อนนะ` : "" });
  } catch (err) {
    console.error("start error:", err);
    setState({ busy: false, error: `เริ่มเกมไม่สำเร็จ: ${err.message}` });
  }
}

// หัวห้องสุ่มคนเขย่าใหม่ (เผื่อคนที่ถูกเลือกไม่อยู่หน้าจอ)
async function rerollTurn() {
  if (!isHost() || Date.now() < rerollReadyAt()) return;
  setState({ busy: true, error: "" });
  try {
    await runTransaction(roomRef, (current) => {
      if (!current?.started || !current.turnId) return;
      const shaken = current.shakenIds ?? {};
      const waiting = (current.players ?? []).filter((p) => !shaken[p.id]);
      const others = waiting.filter((p) => p.id !== current.turnId);
      if (!others.length) return;
      return { ...current, turnId: pickRandom(others).id };
    });
    setState({ busy: false });
  } catch (err) {
    setState({ busy: false, error: `สุ่มใหม่ไม่สำเร็จ: ${err.message}` });
  }
}

// เวลาที่หัวห้องจะกดสุ่มคนเขย่าใหม่ได้: 15 วิ หลังจากตานี้เริ่ม (หรือหลังแอนิเมชันไม้หล่นจบ)
function rerollReadyAt() {
  const last = getDraws(state.round).at(-1);
  const animEnd = last ? (seen[last.id] ?? 0) + SHAKE_MS + DROP_MS : 0;
  return Math.max(turnSeenAt, animEnd) + REROLL_WAIT_MS;
}
function rerollButtonState() {
  const left = Math.ceil((rerollReadyAt() - Date.now()) / 1000);
  return left > 0
    ? { locked: true, text: `คนที่ถูกสุ่มไม่อยู่หน้าจอ? สุ่มคนเขย่าใหม่ได้ในอีก ${left} วิ` }
    : { locked: false, text: "คนที่ถูกสุ่มไม่อยู่หน้าจอ? สุ่มคนเขย่าใหม่" };
}

function canShake() {
  const r = state.round;
  if (!state.me || state.busy || !r?.started) return false;
  if (r.turnId !== state.me.id || getShaken(r)[state.me.id]) return false;
  const { phase } = getPhase();
  return phase !== "shaking" && phase !== "drop";
}

async function shake() {
  if (!canShake()) return;
  const me = state.me;
  const startedAt = Date.now();
  vibrate([80, 50, 80, 50, 80, 50, 80, 50, 80]);
  setState({ pendingShakeAt: startedAt, error: "" });
  later(SHAKE_MS);

  let outcome = null;
  try {
    const result = await runTransaction(
      roomRef,
      (current) => {
        if (!current) {
          outcome = "gone";
          return;
        }
        const players = current.players ?? [];
        const draws = current.draws ?? [];
        const shaken = current.shakenIds ?? {};
        if (!current.started || current.turnId !== me.id || shaken[me.id]) {
          outcome = "notturn";
          return;
        }
        const won = new Set(draws.map((d) => d.winnerId));
        const pool = players.filter((p) => !won.has(p.id));
        if (pool.length === 0) {
          outcome = "empty";
          return;
        }
        const winner = pickRandom(pool);
        const usedNo = new Set(draws.map((d) => d.stickNo));
        const maxNo = Math.max(30, players.length * 3);
        const freeNo = Array.from({ length: maxNo }, (_, i) => i + 1).filter((n) => !usedNo.has(n));
        const nextShaken = { ...shaken, [me.id]: true };
        const waiting = players.filter((p) => !nextShaken[p.id]);
        outcome = "ok";
        return {
          ...current,
          shakenIds: nextShaken,
          turnId: waiting.length ? pickRandom(waiting).id : null, // สุ่มลับ ๆ คนเขย่าคนถัดไป
          draws: [...draws, { id: uid(), winnerId: winner.id, byId: me.id, stickNo: pickRandom(freeNo), at: Date.now() }],
        };
      },
      { applyLocally: false }
    );

    if (outcome === "ok" && result.committed) {
      // ปกติ onValue จะมาก่อนแล้ว เรียกซ้ำไว้กันพลาด (ingest ทำซ้ำได้ไม่มีผลข้างเคียง)
      const pendingShakeAt = ingest(result.snapshot.val());
      setState({ pendingShakeAt });
    } else {
      const msg =
        outcome === "notturn"
          ? "ตอนนี้ไม่ใช่ตาของเธอแล้ว"
          : outcome === "gone"
            ? "ห้องนี้ถูกล้างไปแล้ว"
            : "ไม่มีชื่อเหลือให้สุ่มแล้ว";
      setState({ pendingShakeAt: null, error: msg });
    }
  } catch (err) {
    console.error("shake error:", err);
    setState({ pendingShakeAt: null, error: `เขย่าไม่สำเร็จ: ${err.message}` });
  }
}

// เขย่ามือถือจริง (เปิดเองเมื่ออยากใช้ กันเผลอสุ่มตอนมือถืออยู่ในกระเป๋า)
let lastMotionAt = 0;
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const force = Math.hypot(a.x, a.y, a.z);
  const now = Date.now();
  if (force > 24 && now - lastMotionAt > 1200) {
    lastMotionAt = now;
    shake();
  }
}
async function toggleMotion() {
  if (state.motionOn) {
    window.removeEventListener("devicemotion", onMotion);
    return setState({ motionOn: false });
  }
  try {
    if (typeof DeviceMotionEvent?.requestPermission === "function") {
      const res = await DeviceMotionEvent.requestPermission(); // iOS ต้องขออนุญาตก่อน
      if (res !== "granted") return setState({ error: "ไม่ได้รับอนุญาตให้ใช้เซนเซอร์ เขย่าด้วยปุ่มแทนได้นะ" });
    }
    window.addEventListener("devicemotion", onMotion);
    setState({ motionOn: true, error: "" });
  } catch {
    setState({ error: "เครื่องนี้ใช้เซนเซอร์เขย่าไม่ได้ กดปุ่มแทนได้นะ" });
  }
}
const motionSupported =
  typeof window.DeviceMotionEvent !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

let copyTimer = null;
async function copyLink() {
  const link = window.location.href;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = link;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  clearTimeout(copyTimer);
  setState({ copied: true });
  copyTimer = setTimeout(() => setState({ copied: false }), 1800);
}

function claimIdentity() {
  const mine = { id: state.claim.id, name: state.claim.name };
  saveMe(mine);
  setState({ me: mine, claim: null, error: "" });
}

function openRules() {
  setState({ rulesOpen: true, rulesUnlockAt: 0 }); // เปิดดูซ้ำ ปิดได้ทันที
}
function closeRules() {
  if (Date.now() < state.rulesUnlockAt) return;
  storageSet(RULES_KEY, "1");
  setState({ rulesOpen: false });
}

// หัวห้อง: เริ่มเกมใหม่ เก็บรายชื่อไว้ กลับไปหน้ารอเริ่ม
async function restartGame() {
  setState({ busy: true });
  try {
    await runTransaction(roomRef, (current) => {
      if (!current) return;
      return { ...current, started: null, turnId: null, shakenIds: null, draws: null };
    });
  } catch {}
  setState({ confirm: null, error: "", busy: false });
}

async function resetAll() {
  setState({ busy: true });
  try {
    await remove(roomRef);
  } catch {}
  clearMe();
  setState({ me: null, name: "", claim: null, confirm: null, error: "", busy: false });
}

function renderFooter() {
  if (!isHost()) return "";
  if (state.confirm) {
    const isRoom = state.confirm === "room";
    return `
      <div class="sb-footer">
        <div class="sb-note" style="margin-top:0">${
          isRoom
            ? "ลบทั้งรายชื่อและผลสุ่มของห้องนี้ทั้งหมด"
            : "ล้างผลสุ่มทั้งหมด เก็บรายชื่อไว้ แล้วกลับไปรอหัวห้องกดเริ่มใหม่"
        }</div>
        <button class="sb-link warn" data-action="${isRoom ? "reset-confirm" : "restart-confirm"}" ${
          state.busy ? "disabled" : ""
        }>ยืนยัน</button>
        <button class="sb-link" data-action="confirm-cancel">ไม่เอาแล้ว</button>
      </div>`;
  }
  return `
    <div class="sb-footer">
      ${state.round?.started ? `<button class="sb-link" data-action="restart-ask">เริ่มเกมใหม่</button>` : ""}
      <button class="sb-link" data-action="reset-ask">ล้างห้อง</button>
    </div>`;
}

// กระบอกเซียมซี + ไม้ข้างใน
function renderTube({ phase, elapsed }, stickCount, winnerNo) {
  const n = Math.min(13, Math.max(7, stickCount));
  const sticks = Array.from({ length: n })
    .map((_, i) => {
      const left = 14 + (i * 72) / (n - 1);
      const rise = (i * 37) % 26;
      const tilt = (i - (n - 1) / 2) * 1.6;
      return `<span class="ss-stick" style="left:${left}%;--rise:${rise}px;--tilt:${tilt}deg;--d:${-(i * 53) % 240}ms"></span>`;
    })
    .join("");

  const shakeDelay = phase === "shaking" ? `animation-delay:-${elapsed % (WIGGLE_MS * 2)}ms` : "";
  let fallen = "";
  if (phase === "drop" || phase === "reveal") {
    const t = Math.min(elapsed - SHAKE_MS, DROP_MS);
    fallen = `<div class="ss-fallen" style="animation-delay:-${t}ms"><span>${winnerNo}</span></div>`;
  }

  return `
    <div class="ss-stage">
      <div class="ss-tube${phase === "shaking" ? " is-shaking" : ""}" style="${shakeDelay}">
        <div class="ss-sticks">${sticks}</div>
        <div class="ss-body"><span>โชค</span></div>
      </div>
      ${fallen}
    </div>`;
}

function rulesButtonState() {
  const left = Math.ceil((state.rulesUnlockAt - Date.now()) / 1000);
  return left > 0
    ? { locked: true, text: `อ่านก่อนนะ… (${left})` }
    : { locked: false, text: "เข้าใจแล้ว ไปเล่นกัน!" };
}

// modal กติกาอยู่นอก #app และสร้างครั้งเดียวตอนเปิด
// (ถ้าวาดใหม่ทุกครั้งที่ render แอนิเมชันเปิดจะเล่นซ้ำจนจอกระพริบ)
let rulesEl = null;
function syncRules() {
  document.body.classList.toggle("ss-lock", state.rulesOpen);
  if (!state.rulesOpen) {
    rulesEl?.remove();
    rulesEl = null;
    return;
  }
  if (!rulesEl) {
    rulesEl = document.createElement("div");
    rulesEl.className = "ss-modal";
    rulesEl.setAttribute("role", "dialog");
    rulesEl.setAttribute("aria-modal", "true");
    rulesEl.setAttribute("aria-labelledby", "rules-title");
    rulesEl.innerHTML = `
      <div class="ss-modal-card">
        <div class="sb-eyebrow">อ่านก่อนเล่น</div>
        <h2 class="ss-modal-title" id="rules-title">กติกาเขย่าเซียมซี</h2>
        <ol class="ss-rules">
          <li><b>คนแรกที่ใส่ชื่อคือหัวห้อง</b> ส่งลิงก์ให้เพื่อน แล้วทุกคนใส่ชื่อลงกระบอก</li>
          <li>คนมาครบแล้ว <b>หัวห้องกด “เริ่มเกม”</b> หลังเริ่มแล้วจะเข้าร่วมเพิ่มไม่ได้</li>
          <li>ระบบจะ <b>สุ่มลับ ๆ</b> ว่าใครได้เขย่า คนที่ถูกเลือกจะเห็นบนจอตัวเองคนเดียว คนอื่นไม่รู้ว่าเป็นใคร</li>
          <li>ถ้าจอขึ้นว่า <b>“ถึงตาเธอเขย่า”</b> ให้กดเขย่าเอง ทุกคนในห้องจะเห็นกระบอกสั่นและไม้ที่หล่นออกมาพร้อมกัน</li>
          <li>ทุกคนจะเห็นแค่ <b>เบอร์ไม้</b> ส่วน <b>ชื่อที่จับได้ คนเขย่าจะรู้คนเดียว</b></li>
          <li><b>1 คนเขย่าได้แค่ 1 ครั้ง</b> เขย่าเสร็จ ระบบจะสุ่มคนถัดไปจากคนที่ยังไม่ได้เขย่าต่อไปเรื่อย ๆ</li>
          <li>ชื่อที่ถูกจับไปแล้วจะไม่ถูกจับซ้ำ (มีโอกาสจับได้ชื่อตัวเองนะ)</li>
          <li>ถ้าคนที่ถูกสุ่มไม่อยู่หน้าจอ หัวห้องกดสุ่มคนเขย่าใหม่ได้หลังรอ 15 วินาที</li>
          <li>ถึงตาตัวเองแล้วอย่าให้ใครเห็นจอ และอย่าบอกใครว่าเป็นเรา หรือจับได้ใคร 🤫</li>
        </ol>
        <button class="sb-btn" data-rules-close></button>
      </div>`;
    rulesEl.querySelector("[data-rules-close]").addEventListener("click", closeRules);
    document.body.appendChild(rulesEl);
  }
  const btn = rulesEl.querySelector("[data-rules-close]");
  const { locked, text } = rulesButtonState();
  btn.disabled = locked;
  if (btn.textContent !== text) btn.textContent = text;
}

function renderGameCard(anim, players, draws) {
  const r = state.round;
  const me = state.me;
  const animating = anim.phase === "shaking" || anim.phase === "drop";
  const nameOf = (id) => players.find((p) => p.id === id)?.name ?? "(ออกจากห้องแล้ว)";
  const last = anim.last;
  const myDraw = draws.find((d) => d.byId === me.id);

  let html = `<div class="sb-card"><div class="sb-card-inner">`;
  html += renderTube(anim, players.length, last?.stickNo ?? "?");

  if (anim.phase === "reveal" && last) {
    const revealDelay = Math.min(anim.elapsed - SHAKE_MS - DROP_MS, 600);
    const mineShake = last.byId === me.id;
    html += `
      <div class="ss-result" style="animation-delay:-${revealDelay}ms">
        <div class="sb-label">ไม้ที่หล่นออกมา</div>
        <div class="sb-buddy">เบอร์ ${last.stickNo ?? "?"}</div>
        ${
          mineShake
            ? `<div class="ss-secret">
                 <div class="ss-secret-label">🤫 เธอจับได้ (เห็นคนเดียว)</div>
                 <div class="ss-secret-name">${escapeHtml(nameOf(last.winnerId))}</div>
               </div>`
            : `<div class="sb-hint">มีแค่คนเขย่าที่รู้ว่าไม้นี้เป็นของใคร 🤫</div>`
        }
      </div>`;
  }

  const myShaken = !!getShaken(r)[me.id];
  const gameOver = r?.started && !r.turnId && draws.length > 0;
  const myTurn = r?.started && r.turnId === me.id && !myShaken;

  if (!r?.started) {
    // ห้องรอเริ่ม
    if (isHost()) {
      html += `
        <div class="ss-status"><b>เธอคือหัวห้อง</b><br />รอเพื่อนเข้ามาให้ครบ แล้วกดเริ่มเกมได้เลย</div>
        <button class="sb-btn ss-shake-btn" data-action="start" ${
          players.length < MIN_PLAYERS || state.busy ? "disabled" : ""
        }>${players.length < MIN_PLAYERS ? "รอเพื่อนเข้าห้องก่อน" : `เริ่มเกม (${players.length} คน)`}</button>
        <div class="sb-hint" style="margin-top:8px">กดแล้วระบบจะสุ่มลับ ๆ ว่าใครได้เขย่าคนแรก</div>`;
    } else {
      const hostName = nameOf(getHostId(r));
      html += `<div class="ss-status">รอหัวห้อง <b>${escapeHtml(hostName)}</b> กดเริ่มเกม</div>`;
    }
  } else if (state.pendingShakeAt != null || (animating && anim.last?.byId === me.id)) {
    html += `<button class="sb-btn ss-shake-btn" disabled>กำลังเขย่า…</button>`;
  } else if (animating) {
    // คนอื่นกำลังเขย่า ไม่โชว์อะไรเพิ่ม ให้ดูกระบอกอย่างเดียว
  } else if (myTurn) {
    html += `
      <div class="ss-turn">
        <div class="ss-turn-big">🫵 ถึงตาเธอเขย่า!</div>
        <div>ระบบสุ่มให้ <b>${escapeHtml(me.name)}</b> เป็นคนเขย่าครั้งนี้<br />คนอื่นไม่รู้ว่าเป็นเธอ อย่าให้ใครเห็นจอนะ 🤫</div>
      </div>
      <button class="sb-btn ss-shake-btn" data-action="shake" ${canShake() ? "" : "disabled"}>เขย่าเซียมซี</button>
      ${
        motionSupported
          ? `<button class="sb-pin" data-action="motion">${
              state.motionOn ? "📳 เขย่ามือถือได้เลย (แตะเพื่อปิด)" : "📳 เปิดให้เขย่ามือถือจริงแทนกดปุ่ม"
            }</button>`
          : ""
      }
      <div class="sb-hint" style="margin-top:8px">เขย่าได้ครั้งเดียวนะ</div>`;
  } else if (gameOver) {
    html += `<div class="ss-status"><b>เขย่าครบทุกคนแล้ว 🎉</b></div>`;
  } else if (myShaken) {
    html += `<div class="ss-status">เธอเขย่าไปแล้ว<br />รอคนถัดไปที่ถูกสุ่มเขย่า ไม่มีใครรู้ว่าเป็นใคร 🤫</div>`;
  } else {
    html += `<div class="ss-status">ยังไม่ถึงตาเธอ<br />ถ้าระบบสุ่มได้เธอ จอจะบอกเองนะ 🤫</div>`;
  }

  const showingMine = myDraw && (animating || anim.phase === "reveal") && last?.id === myDraw.id;
  if (myDraw && !showingMine) {
    html += `
      <div class="ss-secret">
        <div class="ss-secret-label">🤫 ไม้เบอร์ ${myDraw.stickNo ?? "?"} ที่เธอเขย่าได้ คือ</div>
        <div class="ss-secret-name">${escapeHtml(nameOf(myDraw.winnerId))}</div>
      </div>`;
  }

  const waitingCount = players.filter((p) => !getShaken(r)[p.id]).length;
  if (r?.started && r.turnId && isHost() && !animating && !myTurn && waitingCount > 1) {
    const { locked, text } = rerollButtonState();
    html += `<button class="sb-pin" data-action="reroll" ${state.busy || locked ? "disabled" : ""}>${text}</button>`;
  }

  if (state.error) html += `<div class="sb-err">${escapeHtml(state.error)}</div>`;
  html += `</div></div>`;
  return html;
}

function render() {
  if (state.loading) {
    root.innerHTML = `<div class="sb-loading">กำลังหยิบกระบอกเซียมซี…</div>`;
    syncRules();
    return;
  }

  const r = state.round;
  const players = getPlayers(r);
  const draws = getDraws(r);
  const anim = getPhase();
  const animating = anim.phase === "shaking" || anim.phase === "drop";
  const hostId = getHostId(r);

  let html = `
    <div class="sb-eyebrow">เสี่ยงทาย</div>
    <h1 class="sb-title">เขย่าเซียมซี<br />หาผู้โชคดี</h1>
    <p class="sb-sub">ระบบสุ่มลับ ๆ ว่าใครได้เขย่า ไม้ที่หล่นออกมาเป็นของใคร มีแค่คนเขย่าที่รู้
      <button class="sb-link" data-action="rules-open">อ่านกติกา</button></p>
  `;

  if (!state.me) {
    html += `<div class="sb-card"><div class="sb-card-inner">`;
    if (state.claim) {
      html += `
        <div class="sb-label">มีชื่อนี้อยู่แล้ว</div>
        <div class="sb-mission" style="margin-bottom:6px">"${escapeHtml(state.claim.name)}" อยู่ในห้องนี้แล้ว</div>
        <div class="sb-hint" style="text-align:left">ถ้านี่คือชื่อของเธอเอง (แค่เปลี่ยนเครื่องหรือรีเฟรชแล้วหลุด) กดปุ่มล่างเพื่อใช้ชื่อเดิมต่อได้เลย</div>
        <button class="sb-btn" data-action="claim-yes">ใช่ นี่ชื่อฉันเอง</button>
        <button class="sb-btn ghost" data-action="claim-no">ใช้ชื่ออื่น</button>
      `;
    } else {
      const started = !!r?.started;
      html += `
        <div class="sb-label">ชื่อของเธอ</div>
        <input class="sb-input" id="name-input" value="${escapeHtml(state.name)}" placeholder="เช่น mp" maxlength="20" />
        <div class="sb-hint" style="text-align:left;margin-top:12px">${
          started
            ? "เกมเริ่มไปแล้ว ถ้าเคยลงชื่อไว้ ใส่ชื่อเดิมเพื่อกลับเข้าห้อง"
            : players.length
              ? `ตอนนี้ในห้องมี ${players.length} คน`
              : "เธอเป็นคนแรก จะได้เป็นหัวห้อง เป็นคนกดเริ่มเกม"
        }</div>
        <button class="sb-btn" data-action="join" ${state.busy ? "disabled" : ""}>${
          state.busy ? "กำลังใส่ชื่อ…" : started ? "กลับเข้าห้อง" : "ใส่ชื่อลงกระบอก"
        }</button>
        ${state.error ? `<div class="sb-err">${escapeHtml(state.error)}</div>` : ""}
      `;
    }
    html += `</div></div>`;
  } else {
    html += renderGameCard(anim, players, draws);

    const shakenCount = Object.keys(getShaken(r)).length;
    html += `
      <div class="sb-card" style="margin-top:16px"><div class="sb-card-inner">
        <div class="sb-label">${r?.started ? "เขย่าไปแล้ว" : "ในห้องตอนนี้"}</div>
        <div class="sb-count">${r?.started ? `${shakenCount}<span> / ${players.length} คน</span>` : `${players.length}<span> คน</span>`}</div>
        <div class="sb-stamps">
          ${players
            .map((p) => {
              const cls = p.id === state.me.id ? "me" : "";
              return `<div class="sb-stamp ${cls}">${p.id === hostId ? "👑 " : ""}${escapeHtml(
                p.name
              )}${p.id === state.me.id ? " (เธอ)" : ""}</div>`;
            })
            .join("")}
        </div>
        ${
          r?.started
            ? ""
            : `<button class="sb-btn ghost" data-action="copy-link">
                 ${state.copied ? "คัดลอกแล้ว! ✓" : "🔗 คัดลอกลิงก์ชวนเพื่อนเข้าห้อง"}
               </button>`
        }
      </div></div>`;

    // เพิ่งถึงตาเรา: สั่นเตือน (ครั้งเดียวต่อรอบ)
    const myTurnNow = r?.started && r.turnId === state.me.id && !getShaken(r)[state.me.id] && !animating;
    const turnKey = myTurnNow ? `${draws.length}` : null;
    if (turnKey && turnKey !== notifiedTurnKey) vibrate([200, 100, 200]);
    notifiedTurnKey = turnKey;
  }

  html += renderFooter();
  root.innerHTML = html;
  attachEvents();
  syncRules();
}

// นับถอยหลังปุ่มปิดกติกา (อัปเดตแค่ปุ่ม ไม่วาดทั้งหน้าใหม่)
setInterval(() => {
  if (state.rulesOpen) syncRules();
  const reroll = root.querySelector('[data-action="reroll"]');
  if (reroll) {
    const { locked, text } = rerollButtonState();
    reroll.disabled = state.busy || locked;
    if (reroll.textContent !== text) reroll.textContent = text;
  }
}, 250);

function attachEvents() {
  const nameInput = document.getElementById("name-input");
  if (nameInput) {
    nameInput.addEventListener("input", (e) => {
      state.name = e.target.value; // ไม่ re-render เพื่อไม่ให้ cursor กระโดด
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !state.busy) join();
    });
    if (!state.rulesOpen) {
      nameInput.focus();
      nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
    }
  }

  root.querySelectorAll("[data-action]").forEach((elm) => {
    elm.addEventListener("click", () => {
      const action = elm.dataset.action;
      if (action === "join") join();
      else if (action === "start") startGame();
      else if (action === "shake") shake();
      else if (action === "reroll") rerollTurn();
      else if (action === "motion") toggleMotion();
      else if (action === "copy-link") copyLink();
      else if (action === "claim-yes") claimIdentity();
      else if (action === "claim-no") setState({ claim: null });
      else if (action === "rules-open") openRules();
      else if (action === "restart-ask") setState({ confirm: "restart" });
      else if (action === "reset-ask") setState({ confirm: "room" });
      else if (action === "confirm-cancel") setState({ confirm: null });
      else if (action === "restart-confirm") restartGame();
      else if (action === "reset-confirm") resetAll();
    });
  });
}

render();
