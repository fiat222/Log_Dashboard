docker run -v $(pwd)/scripts:/scripts \
          -e K6_WEB_DASHBOARD=true \
            -e K6_WEB_DASHBOARD_PERIOD=1s \
              -e K6_WEB_DASHBOARD_EXPORT=/scripts/psu-20-30s.html \
                grafana/k6 run --vus 20 --duration 30s /scripts/script.js
