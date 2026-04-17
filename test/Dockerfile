FROM python:3.12-slim

WORKDIR /app

# ติดตั้ง dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# คัดลอกสคริปต์
COPY stress_test.py .

# รันสคริปต์เมื่อ container เริ่มทำงาน
CMD ["python", "stress_test.py"]