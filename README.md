# buddy-random 🎋

เขย่าเซียมซีหาผู้โชคดี — ทุกคนเข้าห้องเดียวกันผ่านลิงก์ ใส่ชื่อลงกระบอก ใครก็ได้ในห้องกดเขย่า (หรือเขย่ามือถือจริง) ทุกคนจะเห็นกระบอกสั่นและไม้ที่หล่นออกมาพร้อมกัน คนที่ได้ไปแล้วจะไม่ถูกสุ่มซ้ำ เป็นเว็บแอปที่ build ด้วย [Vite](https://vitejs.dev) (ธรรมดา ไม่มี framework) ใช้ Firebase Realtime Database เก็บข้อมูลห้อง (รายชื่อ/ผลสุ่ม ที่ path `luckyRooms/{room}`) ให้ทุกคนเห็นข้อมูลเดียวกันแบบเรียลไทม์

## โครงสร้างไฟล์

```
index.html               หน้าเว็บหลัก (จุดเข้า Vite)
src/style.css            สไตล์ทั้งหมด
src/app.js                ลอจิกของแอป (state, render, event, Firebase)
src/firebase-config.js    ใส่ config ของโปรเจกต์ Firebase ตัวเอง
.github/workflows/deploy.yml  build + deploy ขึ้น GitHub Pages อัตโนมัติ
```

## ติดตั้ง

```bash
npm install
```

## ตั้งค่า Firebase (ทำครั้งเดียว)

1. ไปที่ [Firebase Console](https://console.firebase.google.com/) สร้างโปรเจกต์ใหม่ (ฟรี)
2. เมนูซ้าย > **Build > Realtime Database** > สร้างฐานข้อมูล เลือก location ที่ใกล้ (เช่น `asia-southeast1`)
3. แท็บ **Rules** ตั้งค่าเบื้องต้นสำหรับทดสอบ (เปิดอ่าน/เขียนได้ทุกคน — ใช้เฉพาะตอนเทสหรือกลุ่มเพื่อนปิด ไม่ควรใช้กับข้อมูลสำคัญ):
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
4. ไปที่ **Project settings > General > Your apps** กด **Add app > Web (</>)** ตั้งชื่อแอปอะไรก็ได้ แล้ว copy ค่า `firebaseConfig` ที่ได้
5. เปิดไฟล์ `src/firebase-config.js` แล้ววางค่าที่ copy มาแทนของเดิม

## รันดูในเครื่อง

```bash
npm run dev
```

เปิดลิงก์ที่ terminal บอก (ปกติ `http://localhost:5173`)

## Build

```bash
npm run build
```

ไฟล์ที่ build แล้วจะอยู่ที่โฟลเดอร์ `dist/`

## Deploy บน GitHub Pages (อัตโนมัติผ่าน GitHub Actions)

1. Push โค้ดทั้งหมด (รวม `src/firebase-config.js` ที่ใส่ค่าแล้ว) ขึ้น repo บน GitHub branch `main`
2. ไปที่ repo > **Settings > Pages**
3. Source เลือก **GitHub Actions**
4. Push เข้า `main` ครั้งถัดไป workflow ใน `.github/workflows/deploy.yml` จะ build ด้วย Vite แล้ว deploy ให้อัตโนมัติ
5. รอสักครู่ ดูลิงก์ได้ที่ repo > **Settings > Pages** หรือแท็บ **Actions** ของ run ล่าสุด

ทุกครั้งที่ push โค้ดใหม่เข้า branch `main` เว็บจะอัปเดตอัตโนมัติ
