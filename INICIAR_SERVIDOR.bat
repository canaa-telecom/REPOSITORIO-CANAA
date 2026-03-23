@echo off
title Sala de Reuniao - Canaa Telecom
color 0A

echo.
echo  ================================================
echo   SISTEMA DE RESERVAS - CANAA TELECOM
echo  ================================================
echo.
echo  [1/3] Encerrando processos node em conflito...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo  [2/3] Liberando porta 8085...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8085" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo  [3/3] Iniciando servidor...
echo.
echo  Acesse em: http://localhost:8085
echo.

npm run dev

pause
