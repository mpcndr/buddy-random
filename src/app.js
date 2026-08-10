import { firebaseConfig } from "./firebase-config.js";
import { MISSIONS } from "./missions.js";
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
const ME_KEY = `buddy_me_v1_${ROOM_ID}`;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const roundRef = ref(db, `rooms/${ROOM_ID}`);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// วนเป็นวงกลมเดียว: ทุกคนได้บัดดี้ 1 คน ไม่ซ้ำ และไม่มีใครได้ตัวเอง
function drawAssignments(players) {
  const ring = shuffle(players);
  const missions = shuffle(MISSIONS).slice(0, ring.length);
  const out = {};
  ring.forEach((p, i) => {
    out[p.id] = {
      buddyId: ring[(i + 1) % ring.length].id,
      mission: missions[i],
    };
  });
  return out;
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
  localStorage.setItem(ME_KEY, JSON.stringify(me));
}
function clearMe() {
  localStorage.removeItem(ME_KEY);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const state = {
  round: null,
  me: loadMe(),
  loading: true,
  name: "",
  total: 5,
  error: "",
  claim: null,
  busy: false,
  held: false,
  pinned: false,
  confirmReset: false,
  copied: false,
};

const root = document.getElementById("app");

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// รับข้อมูลรอบแบบเรียลไทม์จาก Firebase
onValue(
  roundRef,
  (snapshot) => {
    const data = snapshot.val();
    let mine = state.me;
    if (mine && data && !data.players.some((p) => p.id === mine.id)) {
      const sameName = data.players.find((p) => p.name === mine.name);
      mine = sameName ? { id: sameName.id, name: sameName.name } : null;
      if (!mine) clearMe();
      else saveMe(mine);
    }
    setState({ round: data, me: mine, loading: false });
  },
  (err) => {
    console.error("onValue error:", err);
    setState({ loading: false, error: `อ่านข้อมูลไม่ได้: ${err.message}` });
  }
);

async function join() {
  const clean = state.name.trim().replace(/\s+/g, " ");
  if (!clean) return setState({ error: "ใส่ชื่อก่อนนะ" });
  if (clean.length > 20) return setState({ error: "ชื่อยาวไป ใช้ไม่เกิน 20 ตัวอักษร" });

  setState({ busy: true, error: "" });

  const myId = uid();
  const desiredTotal = state.total;
  let outcome = null;
  let dupPlayer = null;

  try {
    const result = await runTransaction(roundRef, (current) => {
      const data = current || { total: desiredTotal, players: [], createdAt: Date.now() };
      const dup = data.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
      if (dup) {
        outcome = "duplicate";
        dupPlayer = dup;
        return; // abort, ไม่แก้ไขอะไร
      }
      if (data.players.length >= data.total) {
        outcome = "full";
        return; // abort
      }
      const mine = { id: myId, name: clean };
      const nextPlayers = [...data.players, mine];
      const nextRound = { ...data, players: nextPlayers };
      if (nextPlayers.length === data.total) nextRound.assignments = drawAssignments(nextPlayers);
      outcome = "ok";
      return nextRound;
    });

    if (outcome === "ok" && result.committed) {
      const mine = { id: myId, name: clean };
      saveMe(mine);
      setState({ me: mine, busy: false });
    } else if (outcome === "duplicate") {
      setState({ claim: dupPlayer, busy: false });
    } else if (outcome === "full") {
      setState({ error: "รอบนี้คนครบแล้ว รอเพื่อนเปิดรอบใหม่นะ", busy: false });
    } else {
      setState({ busy: false });
    }
  } catch (err) {
    console.error("join error:", err);
    setState({ error: `บันทึกไม่สำเร็จ: ${err.message}`, busy: false });
  }
}

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

async function resetAll() {
  setState({ busy: true });
  try {
    await remove(roundRef);
  } catch {}
  clearMe();
  setState({
    me: null,
    name: "",
    claim: null,
    confirmReset: false,
    error: "",
    pinned: false,
    held: false,
    busy: false,
  });
}

function renderResetFooter() {
  if (state.confirmReset) {
    return `
      <div class="sb-footer">
        <div class="sb-note" style="margin-top:0">ล้างชื่อและผลของทุกคนในรอบนี้ทั้งหมด</div>
        <button class="sb-link warn" data-action="reset-confirm" ${state.busy ? "disabled" : ""}>ยืนยัน ล้างรอบนี้</button>
        <button class="sb-link" data-action="reset-cancel">ไม่เอาแล้ว</button>
      </div>`;
  }
  return `
    <div class="sb-footer">
      <button class="sb-link" data-action="reset-ask">เริ่มรอบใหม่</button>
    </div>`;
}

function render() {
  if (state.loading) {
    root.innerHTML = `
      <div class="sb-loading">กำลังเปิดกล่องจดหมาย…</div>`;
    return;
  }

  const players = state.round?.players ?? [];
  const cap = state.round?.total ?? state.total;
  const mine = state.me && state.round?.assignments ? state.round.assignments[state.me.id] : null;
  const buddy = mine ? players.find((p) => p.id === mine.buddyId) : null;
  const open = state.held || state.pinned;

  let html = `
    <div class="sb-eyebrow">จดหมายลับ</div>
    <h1 class="sb-title">สุ่มบัดดี้ + ภารกิจ</h1>
    <p class="sb-sub">ทุกคนใส่ชื่อลงไป พอครบคนแล้วระบบจะจับคู่ให้ ไม่มีใครได้ซ้ำ และเห็นได้แค่ของตัวเอง</p>
  `;

  if (!state.me) {
    html += `<div class="sb-card"><div class="sb-card-inner">`;
    if (state.claim) {
      html += `
        <div class="sb-label">มีชื่อนี้อยู่แล้ว</div>
        <div class="sb-mission" style="margin-bottom:6px">"${escapeHtml(state.claim.name)}" ลงชื่อไปแล้วในรอบนี้</div>
        <div class="sb-hint" style="text-align:left">ถ้านี่คือชื่อของเธอเอง (แค่เปลี่ยนเครื่องหรือรีเฟรชแล้วหลุด) กดปุ่มล่างเพื่อใช้ชื่อเดิมต่อได้เลย</div>
        <button class="sb-btn" data-action="claim-yes">ใช่ นี่ชื่อฉันเอง</button>
        <button class="sb-btn ghost" style="color:#8a6b4a;border-color:rgba(90,60,40,.3)" data-action="claim-no">ใช้ชื่ออื่น</button>
      `;
    } else {
      html += `
        <div class="sb-label">ชื่อของเธอ</div>
        <input class="sb-input" id="name-input" value="${escapeHtml(state.name)}" placeholder="เช่น mp" maxlength="20" />
      `;
      if (players.length === 0 && !state.round) {
        html += `
          <div class="sb-label" style="margin-top:18px">รอบนี้มีกี่คน</div>
          <div class="sb-picker">
            ${[3, 4, 5, 6, 7, 8]
              .map(
                (n) =>
                  `<button class="sb-pick${state.total === n ? " on" : ""}" data-action="pick-total" data-n="${n}">${n}</button>`
              )
              .join("")}
          </div>
          <div class="sb-hint" style="text-align:left;margin-top:8px">คนแรกที่ลงชื่อเป็นคนตั้งจำนวน หลังจากนั้นล็อกไว้เลย</div>
        `;
      }
      if (state.round) {
        html += `<div class="sb-hint" style="text-align:left;margin-top:12px">ตอนนี้มีคนลงชื่อแล้ว ${players.length} จาก ${cap} คน</div>`;
      }
      html += `
        <button class="sb-btn" data-action="join" ${state.busy ? "disabled" : ""}>${state.busy ? "กำลังหย่อนชื่อ…" : "หย่อนชื่อลงกล่อง"}</button>
        ${state.error ? `<div class="sb-err">${escapeHtml(state.error)}</div>` : ""}
      `;
    }
    html += `</div></div>`;
  }

  if (state.me && !state.round?.assignments) {
    html += `
      <div class="sb-card"><div class="sb-card-inner">
        <div class="sb-label">รอเพื่อนอยู่</div>
        <div class="sb-count">${players.length}<span> / ${cap} คน</span></div>
        <div class="sb-stamps">
          ${players
            .map(
              (p) =>
                `<div class="sb-stamp${p.id === state.me.id ? " me" : ""}">${escapeHtml(p.name)}${p.id === state.me.id ? " (เธอ)" : ""}</div>`
            )
            .join("")}
          ${Array.from({ length: Math.max(0, cap - players.length) })
            .map(() => `<div class="sb-stamp empty">ยังว่าง</div>`)
            .join("")}
        </div>
        <div class="sb-hint" style="text-align:left;margin-top:18px">ส่งลิงก์นี้ให้เพื่อนที่เหลือ พอครบ ${cap} คนเมื่อไหร่ ซองของเธอจะเด้งขึ้นมาเอง</div>
        <button class="sb-btn ghost" data-action="copy-link">
          ${state.copied ? "คัดลอกแล้ว! ✓" : "🔗 คัดลอกลิงก์เชิญเพื่อน"}
        </button>
      </div></div>`;
  }

  if (state.me && mine && buddy) {
    html += `<div class="sb-card"><div class="sb-card-inner">`;
    if (!open) {
      html += `
        <div class="sb-seal-zone">
          <div class="sb-label" style="margin-bottom:0">ซองของ ${escapeHtml(state.me.name)}</div>
          <button class="sb-seal${state.held ? " on" : ""}" id="seal-btn">กดค้าง</button>
          <div class="sb-hint">กดค้างไว้เพื่ออ่าน ปล่อยเมื่อไหร่ปิดทันที<br />หันจอเข้าหาตัวเองก่อนนะ</div>
        </div>`;
    } else {
      html += `
        <div class="sb-reveal" id="reveal-zone" style="touch-action:none">
          <div class="sb-label">บัดดี้ของเธอคือ</div>
          <div class="sb-buddy">${escapeHtml(buddy.name)}</div>
          <div class="sb-rule"></div>
          <div class="sb-label">ภารกิจ</div>
          <div class="sb-mission">${escapeHtml(mine.mission)}</div>
          <button class="sb-pin" data-action="pin-toggle">${state.pinned ? "ปิดซอง" : "เปิดค้างไว้ (ถ้าไม่มีใครมอง)"}</button>
        </div>`;
    }
    html += `</div></div>`;
  }

  if (!state.me && state.round?.assignments && !state.claim) {
    html += `<div class="sb-note">รอบนี้จับคู่เรียบร้อยแล้ว ถ้าอยากเล่นใหม่ให้กด "เริ่มรอบใหม่" ด้านล่าง</div>`;
  }

  html += renderResetFooter();
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

  const sealBtn = document.getElementById("seal-btn");
  if (sealBtn) {
    const down = (e) => {
      sealBtn.setPointerCapture?.(e.pointerId);
      setState({ held: true });
    };
    const up = () => setState({ held: false });
    sealBtn.addEventListener("pointerdown", down);
    sealBtn.addEventListener("pointerup", up);
    sealBtn.addEventListener("pointercancel", up);
    sealBtn.addEventListener("pointerleave", up);
    sealBtn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const revealZone = document.getElementById("reveal-zone");
  if (revealZone) {
    const up = () => setState({ held: false });
    revealZone.addEventListener("pointerup", up);
    revealZone.addEventListener("pointercancel", up);
    revealZone.addEventListener("pointerleave", up);
  }

  root.querySelectorAll("[data-action]").forEach((elm) => {
    elm.addEventListener("click", () => {
      const action = elm.dataset.action;
      if (action === "join") join();
      else if (action === "copy-link") copyLink();
      else if (action === "claim-yes") claimIdentity();
      else if (action === "claim-no") setState({ claim: null });
      else if (action === "pick-total") setState({ total: Number(elm.dataset.n) });
      else if (action === "pin-toggle") setState({ pinned: !state.pinned });
      else if (action === "reset-ask") setState({ confirmReset: true });
      else if (action === "reset-cancel") setState({ confirmReset: false });
      else if (action === "reset-confirm") resetAll();
    });
  });
}

render();
