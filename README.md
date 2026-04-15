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

## การ Deploy ระดับ Production (ใช้ Domain + Nginx DNS)

เมื่อต้องการนำระบบไปใช้งานจริงบน Server ที่มี Domain Name ให้แก้ไข 2 จุดหลัก:

### 1. แก้ `dashboard/nginx.conf.template`

เปลี่ยน `server_name` จาก wildcard `_` ให้เป็น domain จริง และเพิ่ม HTTPS:

```nginx
server {
    listen 80;
    server_name logs.example.com;   # ← แทนที่ด้วย domain จริง

    # Redirect HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name logs.example.com;   # ← แทนที่ด้วย domain จริง

    ssl_certificate     /etc/letsencrypt/live/logs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/logs.example.com/privkey.pem;

    # ... (ส่วน location / และ /clickhouse/ เหมือนเดิม)
}
```

> **หมายเหตุ:** ใบรับรอง SSL สามารถออกได้ฟรีด้วย [Certbot (Let's Encrypt)](https://certbot.eff.org/)
> ```bash
> certbot certonly --standalone -d logs.example.com
> ```

### 2. ล็อก CORS ใน `/clickhouse/` location

ใน Development ตั้งค่าไว้กว้าง (`*`) เพื่อความสะดวก แต่ใน Production ควรจำกัดให้เฉพาะ domain ของตัวเอง:

```nginx
# แก้ใน nginx.conf.template — location /clickhouse/ และ /clickhouse-admin/
add_header Access-Control-Allow-Origin  "https://logs.example.com" always;  # ← ระบุ domain จริง แทน *
```

### 3. ปิด Port ที่ไม่จำเป็นใน `docker-compose.yml`

บน Production ไม่ควร expose port ของ ClickHouse และ Redis ออกมาโดยตรง:

```yaml
# clickhouse — ลบหรือ comment บรรทัดนี้:
# ports:
#   - "8123:8123"
#   - "9000:9000"

# redis — ลบหรือ comment บรรทัดนี้:
# ports:
#   - "6379:6379"
```

Nginx container ยังคงติดต่อกับ ClickHouse ได้ผ่าน Docker internal network (`clickhouse:8123`) อยู่ โดยไม่ต้องเปิด port ออก Internet

### 4. DNS Record ที่ต้องตั้งค่า

| Type | Name | Value |
|------|------|-------|
| `A` | `logs.example.com` | `<IP ของ Server>` |
| `A` | `grafana.example.com` | `<IP ของ Server>` *(optional)* |

---

## โครงสร้างไฟล์ที่สำคัญ

- `docker-compose.yml`: ไฟล์หลักในการรันระบบ Services ทุกอย่าง
- `clickhouse/init.sql`: ไฟล์ Database Schema (ตารางและ MV) สำหรับ ClickHouse
- `dashboard/`: เก็บไฟล์ HTML/JS/CSS สำหรับหน้าเว็บ Log
- `dashboard/nginx.conf.template`: Config ของ Nginx ที่ serve dashboard และ proxy ไปยัง ClickHouse
- `ingester/`: สคริปต์ Python ในการสูบ Log จาก Redis ไปเก็บใน ClickHouse
- `filebeat.yml`: Config กรองเฉพาะเนื้อหา Log ก่อนโยนส่งต่อไป

## ข้อควรระวัง
- ไฟล์รหัสผ่านอย่าง `.env` ห้ามนำขึ้น Git เด็ดขาด (มีตั้งค่าไว้ใน `.gitignore` เรียบร้อยแล้ว)
- ClickHouse v24.3-alpine ต้องรันบน CPU ที่รองรับชุดคำสั่ง AVX/SSE4.2 เป็นขั้นต่ำ
- **Production:** ห้าม expose port `8123` (ClickHouse) และ `6379` (Redis) ออก Internet โดยตรง — ให้ผ่าน Nginx เท่านั้น
- **Production:** เปลี่ยน `CLICKHOUSE_PASSWORD` และ `GRAFANA_PASSWORD` ใน `.env` ให้เป็นรหัสผ่านที่แข็งแรงก่อน deploy
