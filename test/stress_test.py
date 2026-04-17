import asyncio
import httpx
import time
import statistics

# ── Configuration ─────────────────────────────────────────────────────────────
TARGET_URL = "http://localhost/log/api/health"
TOTAL_REQUESTS = 2000
CONCURRENT_LIMIT = 50 

async def send_request(client, semaphore, results):
    async with semaphore:
        start_time = time.perf_counter()
        try:
            resp = await client.get(TARGET_URL, timeout=10.0)
            end_time = time.perf_counter()
            results.append({
                "status": resp.status_code,
                "latency": end_time - start_time
            })
        except Exception as e:
            results.append({
                "status": "Error",
                "error": str(e),
                "latency": 0
            })

async def main():
    print(f"🚀 Starting Stress Test: {TARGET_URL}")
    print(f"📊 Total Requests: {TOTAL_REQUESTS} | Concurrency: {CONCURRENT_LIMIT}")
    
    semaphore = asyncio.Semaphore(CONCURRENT_LIMIT)
    results = []
    
    async with httpx.AsyncClient() as client:
        tasks = [send_request(client, semaphore, results) for _ in range(TOTAL_REQUESTS)]
        await asyncio.gather(*tasks)
    
    # Analyze results
    success = [r for r in results if r.get("status") == 200]
    errors = [r for r in results if r.get("status") != 200]
    latencies = [r["latency"] for r in success]
    
    print("\n" + "="*40)
    print("📈 STRESS TEST RESULTS")
    print("="*40)
    print(f"✅ Success: {len(success)}")
    print(f"❌ Failed:  {len(errors)}")
    
    if latencies:
        print(f"⚡ Avg Latency: {statistics.mean(latencies)*1000:.2f} ms")
        print(f"🎯 Min Latency: {min(latencies)*1000:.2f} ms")
        print(f"🔥 Max Latency: {max(latencies)*1000:.2f} ms")
    
    if errors:
        print("\n⚠️ Error Sample (First 3):")
        for err in errors[:3]:
            print(f"   - {err}")

if __name__ == "__main__":
    start = time.perf_counter()
    asyncio.run(main())
    print(f"\n✨ Total duration: {time.perf_counter() - start:.2f}s")