#!/bin/bash

# Start crond in the background
crond -l 2

# Start the backup trigger API server
python3 /usr/local/bin/server.py
