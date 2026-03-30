# Log_Dashboard

ระบบ Pipeline จัดการและแสดงผล Log (Log Pipeline & Dashboard) 
ระบบนี้ถูกออกแบบมาเพื่อเก็บรวบรวม, พักข้อมูล, จัดเก็บระยะยาว, และแสดงผล Log ของทุก Docker Container ภายในเซิร์ฟเวอร์แบบ Real-time

## สถาปัตยกรรมระบบ (Architecture)

ระบบประกอบด้วยหลาย Container ทำงานร่วมกันดังนี้:

1. **Filebeat** 
   ทำหน้าที่อ่าน Log ทั้งหมดจาก Docker socket โดยตรง แล้วส่งข้อมูลต่อไปที่ Redis
2. **Redis** 
   ทำหน้าที่เป็น Buffer/Message Queue รับ Log ชั่วคราว เพื่อลดภาระการเขียนลงฐานข้อมูลพร้อมๆ กันหลายๆ Transaction
3. **Log Ingester (Python)** 
   ดึงข้อมูลจาก Redis ทีละ Batch (เช่น ครั้งละ 200 บรรทัด หรือทุก 3 วินาที) แล้วนำไป Insert ลง ClickHouse ทีเดียวเพื่อประสิทธิภาพที่สูงสุด
4. **ClickHouse** 
   ฐานข้อมูลแบบ Column-oriented ที่เหมาะมากสำหรับการเก็บ Log จำนวนมหาศาลและประมวลผลการค้นหาได้อย่างรวดเร็ว
5. **Log Dashboard (Nginx)** 
   หน้าเว็บ SPA (Single Page Application) Custom UI ที่เราเขียนเอง ติดต่อกับ ClickHouse API โดยตรงเพื่อแสดง Log
6. **Grafana + Prometheus + cAdvisor** 
   - **cAdvisor:** ดึง Metrics ยอดการใช้งาน CPU/RAM ของแต่ละ Container
   - **Prometheus:** เก็บรวมรวม Metrics เหล่านั้น
   - **Grafana:** หน้า Dashboard ดึงข้อมูลจากทั้ง ClickHouse และ Prometheus มาสร้างกราฟสรุป
7. **Traefik** 
   ทำหน้าที่เป็น Reverse Proxy สำหรับจัดการ Routing ให้ง่ายขึ้น (จัดการพอร์ต 80, 443 ให้กับ Services ข้างต้น)

## วิธีการใช้งาน (How to run)

1. **ตั้งค่า Environment**
   คัดลอกไฟล์ `.env.example` มาสร้างใหม่เป็น `.env` และทำการแก้ไขรหัสผ่าน
   ```bash
   cp .env.example .env
   ```

2. **สั่งรันระบบ (ด้วย Docker Compose)**
   ```bash
   docker-compose up -d
   ```

3. **หน้าเว็บต่างๆ ที่สามารถเข้าถึงได้ (โหมด Localhost / PC Test)**
   - **Log Dashboard**: `http://localhost/` หรือ `http://localhost:80`
   - **Grafana Dashboard**: `http://localhost:3000`
   - **Traefik Control**: `http://localhost:8090/dashboard/`
   - **Prometheus**: `http://localhost:9090`

## โครงสร้างไฟล์ที่สำคัญ

- `docker-compose.yml`: ไฟล์หลักในการรันระบบ Services ทุกอย่าง
- `clickhouse/init.sql`: ไฟล์ Database Schema (ตารางและ MV) สำหรับ ClickHouse
- `dashboard/`: เก็บไฟล์ HTML/JS/CSS สำหรับหน้าเว็บ Log
- `ingester/`: สคริปต์ Python ในการสูบ Log จาก Redis ไปเก็บใน ClickHouse
- `filebeat.yml`: Config กรองเฉพาะเนื้อหา Log ก่อนโยนส่งต่อไป

## ข้อควรระวัง
- ไฟล์รหัสผ่านอย่าง `.env` ห้ามนำขึ้น Git เด็ดขาด (มีตั้งค่าไว้ใน `.gitignore` เรียบร้อยแล้ว)
- ClickHouse v24.3-alpine ต้องรันบน CPU ที่รองรับชุดคำสั่ง AVX/SSE4.2 เป็นขั้นต่ำ
