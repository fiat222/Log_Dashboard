#!/bin/bash
# Schedule lives in backend (APScheduler). This container only runs the HTTP trigger.
python3 /usr/local/bin/server.py
