@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dev\scripts\grill-with-docs.ps1" %*
