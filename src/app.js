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

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const roomRef = ref(db, `rooms/${ROOM_ID}`);
const drawsRef = ref(db, `rooms/${ROOM_ID}/draws`);

const SHAKE_MS = 2600; // ช่วงเขย่ากระบอก
const DROP_MS = 1100; // ช่วงไม้เซียมซีหล่นออกมา
const MIN_PLAYERS = 2;
const WIGGLE_MS = 300; // ความยาว 1 จังหวะของท่าเขย่า (ต้องตรงกับใน CSS)

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function loadMe() {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveMe(me) {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {}
}
function clearMe() {
  try {
    localStorage.removeItem(ME_KEY);
  } catch {}
}

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

const state = {
  round: null,
  me: loadMe(),
  loading: true,
  name: "",
  error: "",
  claim: null,
  busy: false,
  confirm: null, // null | "draws" | "room"
  copied: false,
  pendingShakeAt: null, // เวลาที่เรากดเขย่าเอง (ระหว่างรอผลจาก Firebase)
  motionOn: false,
};

// drawId -> เวลาบนเครื่องนี้ที่เริ่มเล่นแอนิเมชันของการสุ่มครั้งนั้น
// (ใช้เวลาเครื่องตัวเอง ไม่ใช้เวลาจากเครื่องคนกด กันนาฬิกาแต่ละเครื่องไม่ตรงกัน)
const seen = {};
let firstSnapshot = true;

const root = document.getElementById("app");

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function later(ms) {
  setTimeout(render, Math.max(0, ms) + 20);
}

function getDraws(round) {
  return round?.draws ?? [];
}
function getPlayers(round) {
  return round?.players ?? [];
}

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
      outcome = "ok";
      return { ...data, players: [...players, { id: myId, name: clean }] };
    });

    if (outcome === "ok" && result.committed) {
      const mine = { id: myId, name: clean };
      saveMe(mine);
      setState({ me: mine, busy: false, name: "" });
    } else if (outcome === "duplicate") {
      setState({ claim: dupPlayer, busy: false });
    } else {
      setState({ busy: false });
    }
  } catch (err) {
    console.error("join error:", err);
    setState({ error: `บันทึกไม่สำเร็จ: ${err.message}`, busy: false });
  }
}

function canShake() {
  if (!state.me || state.busy) return false;
  const { phase } = getPhase();
  if (phase === "shaking" || phase === "drop") return false;
  const players = getPlayers(state.round);
  const won = new Set(getDraws(state.round).map((d) => d.winnerId));
  return players.length >= MIN_PLAYERS && players.some((p) => !won.has(p.id));
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
        const lastDraw = draws[draws.length - 1];
        if (lastDraw && Date.now() - lastDraw.at < SHAKE_MS + DROP_MS) {
          outcome = "busy"; // มีคนอื่นเพิ่งเขย่าไปพร้อม ๆ กัน
          return;
        }
        const won = new Set(draws.map((d) => d.winnerId));
        const pool = players.filter((p) => !won.has(p.id));
        if (players.length < MIN_PLAYERS || pool.length === 0) {
          outcome = "empty";
          return;
        }
        const winner = pool[Math.floor(Math.random() * pool.length)];
        outcome = "ok";
        return {
          ...current,
          draws: [...draws, { id: uid(), winnerId: winner.id, byId: me.id, at: Date.now() }],
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
        outcome === "busy"
          ? "มีเพื่อนเขย่าไปพร้อมกันพอดี รอดูผลก่อนนะ"
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
  setState({ me: mine, claim: null });
}

async function clearDraws() {
  setState({ busy: true });
  try {
    await remove(drawsRef);
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

function renderFooter(hasDraws) {
  if (state.confirm) {
    const isRoom = state.confirm === "room";
    return `
      <div class="sb-footer">
        <div class="sb-note" style="margin-top:0">${
          isRoom ? "ล้างทั้งรายชื่อและผลสุ่มของห้องนี้ทั้งหมด" : "ล้างผลสุ่มทั้งหมด แต่เก็บรายชื่อไว้เหมือนเดิม"
        }</div>
        <button class="sb-link warn" data-action="${isRoom ? "reset-confirm" : "clear-confirm"}" ${
          state.busy ? "disabled" : ""
        }>ยืนยัน</button>
        <button class="sb-link" data-action="confirm-cancel">ไม่เอาแล้ว</button>
      </div>`;
  }
  return `
    <div class="sb-footer">
      ${hasDraws ? `<button class="sb-link" data-action="clear-ask">สุ่มใหม่ตั้งแต่ต้น</button>` : ""}
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

function render() {
  if (state.loading) {
    root.innerHTML = `<div class="sb-loading">กำลังหยิบกระบอกเซียมซี…</div>`;
    return;
  }

  const players = getPlayers(state.round);
  const draws = getDraws(state.round);
  const anim = getPhase();
  const animating = anim.phase === "shaking" || anim.phase === "drop";
  // ระหว่างเขย่า ซ่อนผลครั้งล่าสุดไว้ก่อน ไม่ให้สปอยล์
  const shownDraws = animating && anim.last ? draws.slice(0, -1) : draws;
  const wonIds = new Set(shownDraws.map((d) => d.winnerId));
  const remaining = players.filter((p) => !getDraws(state.round).some((d) => d.winnerId === p.id));
  const nameOf = (id) => players.find((p) => p.id === id)?.name ?? "(ออกจากห้องแล้ว)";
  const numberOf = (id) => players.findIndex((p) => p.id === id) + 1 || "?";

  let html = `
    <div class="sb-eyebrow">เสี่ยงทาย</div>
    <h1 class="sb-title">เขย่าเซียมซี<br />หาผู้โชคดี</h1>
    <p class="sb-sub">ทุกคนเข้าห้องแล้วใส่ชื่อ ใครก็ได้ในห้องกดเขย่า ทุกคนจะเห็นกระบอกสั่นพร้อมกัน แล้วไม้ที่หล่นออกมาคือผู้โชคดี</p>
  `;

  // ยังไม่ได้ลงชื่อ
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
      html += `
        <div class="sb-label">ชื่อของเธอ</div>
        <input class="sb-input" id="name-input" value="${escapeHtml(state.name)}" placeholder="เช่น mp" maxlength="20" />
        ${players.length ? `<div class="sb-hint" style="text-align:left;margin-top:12px">ตอนนี้ในห้องมี ${players.length} คน</div>` : ""}
        <button class="sb-btn" data-action="join" ${state.busy ? "disabled" : ""}>${
          state.busy ? "กำลังใส่ชื่อ…" : "ใส่ชื่อลงกระบอก"
        }</button>
        ${state.error ? `<div class="sb-err">${escapeHtml(state.error)}</div>` : ""}
      `;
    }
    html += `</div></div>`;
  }

  // ลงชื่อแล้ว: กระบอกเซียมซี
  if (state.me) {
    const winnerId = anim.last?.winnerId;
    html += `<div class="sb-card"><div class="sb-card-inner">`;
    html += renderTube(anim, players.length, winnerId ? numberOf(winnerId) : "");

    if (anim.phase === "reveal" && winnerId) {
      const isMe = winnerId === state.me.id;
      const revealDelay = Math.min(anim.elapsed - SHAKE_MS - DROP_MS, 600);
      html += `
        <div class="ss-result" style="animation-delay:-${revealDelay}ms">
          <div class="sb-label">ไม้เบอร์ ${numberOf(winnerId)} · ผู้โชคดีคือ</div>
          <div class="sb-buddy">${escapeHtml(nameOf(winnerId))}</div>
          ${isMe ? `<div class="ss-me">🎉 เธอเองนี่แหละ!</div>` : ""}
        </div>`;
    }

    let label = draws.length ? "เขย่าอีกครั้ง" : "เขย่าเซียมซี";
    if (animating) label = "กำลังเขย่า…";
    else if (players.length < MIN_PLAYERS) label = "รอเพื่อนเข้าห้องก่อน";
    else if (remaining.length === 0) label = "ทุกคนได้ไปครบแล้ว";

    html += `
      <button class="sb-btn ss-shake-btn" data-action="shake" ${canShake() ? "" : "disabled"}>${label}</button>
      ${
        motionSupported
          ? `<button class="sb-pin" data-action="motion">${
              state.motionOn ? "📳 เขย่ามือถือได้เลย (แตะเพื่อปิด)" : "📳 เปิดให้เขย่ามือถือจริงแทนกดปุ่ม"
            }</button>`
          : ""
      }
      ${state.error ? `<div class="sb-err">${escapeHtml(state.error)}</div>` : ""}
      <div class="sb-hint" style="margin-top:8px">${
        draws.length ? "คนที่ได้ไปแล้วจะไม่ถูกสุ่มซ้ำ" : "ทุกคนในห้องจะเห็นผลพร้อมกัน"
      }</div>
    </div></div>`;

    // รายชื่อในห้อง
    html += `
      <div class="sb-card" style="margin-top:16px"><div class="sb-card-inner">
        <div class="sb-label">ในกระบอกตอนนี้</div>
        <div class="sb-count">${players.length}<span> คน</span></div>
        <div class="sb-stamps">
          ${players
            .map((p) => {
              const cls = [wonIds.has(p.id) ? "won" : "", p.id === state.me.id ? "me" : ""].join(" ");
              return `<div class="sb-stamp ${cls}">${wonIds.has(p.id) ? "🏆 " : ""}${escapeHtml(p.name)}${
                p.id === state.me.id ? " (เธอ)" : ""
              }</div>`;
            })
            .join("")}
        </div>
        ${
          shownDraws.length
            ? `<div class="sb-rule" style="margin-top:18px"></div>
               <div class="sb-label">ผู้โชคดีที่ผ่านมา</div>
               <ol class="ss-history">
                 ${shownDraws
                   .map((d) => `<li><span>ไม้เบอร์ ${numberOf(d.winnerId)}</span>${escapeHtml(nameOf(d.winnerId))}</li>`)
                   .join("")}
               </ol>`
            : ""
        }
        <button class="sb-btn ghost" data-action="copy-link">
          ${state.copied ? "คัดลอกแล้ว! ✓" : "🔗 คัดลอกลิงก์ชวนเพื่อนเข้าห้อง"}
        </button>
      </div></div>`;
  }

  html += renderFooter(draws.length > 0);
  root.innerHTML = html;
  attachEvents();
}

function attachEvents() {
  const nameInput = document.getElementById("name-input");
  if (nameInput) {
    nameInput.addEventListener("input", (e) => {
      state.name = e.target.value; // ไม่ re-render เพื่อไม่ให้ cursor กระโดด
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !state.busy) join();
    });
    nameInput.focus();
    nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
  }

  root.querySelectorAll("[data-action]").forEach((elm) => {
    elm.addEventListener("click", () => {
      const action = elm.dataset.action;
      if (action === "join") join();
      else if (action === "shake") shake();
      else if (action === "motion") toggleMotion();
      else if (action === "copy-link") copyLink();
      else if (action === "claim-yes") claimIdentity();
      else if (action === "claim-no") setState({ claim: null });
      else if (action === "clear-ask") setState({ confirm: "draws" });
      else if (action === "reset-ask") setState({ confirm: "room" });
      else if (action === "confirm-cancel") setState({ confirm: null });
      else if (action === "clear-confirm") clearDraws();
      else if (action === "reset-confirm") resetAll();
    });
  });
}

render();
