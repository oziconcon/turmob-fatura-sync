@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo .env dosyası oluşturuluyor...
(
  echo TURMOB_USER=18224806438
  echo TURMOB_PASS=Begum2025@@
  echo SUPABASE_URL=https://yjyhwtslihxsultmlrlr.supabase.co
  echo SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqeWh3dHNsaWh4c3VsdG1scmxyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NTE3MzYsImV4cCI6MjEwNjQyNzczNn0.61nIHAq-WLo20u3IqcDqYW_CnVPC8Dnlkra_ug-G7qY
) > .env

echo Faturalar senkronize ediliyor...
node sync.js
pause
