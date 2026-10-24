@echo off
chcp 65001 >nul
title Project_Godeok 서버
cd /d "%~dp0"

echo.
echo  Project_Godeok 서버를 시작합니다...
echo  (이 창을 닫으면 게임이 끊깁니다. 수업이 끝날 때까지 켜 두세요)
echo.

set "NODEEXE="

rem 1) PATH 에 등록된 node
where node >nul 2>nul
if not errorlevel 1 set "NODEEXE=node"

rem 2) 이 폴더에 node.exe 를 넣어둔 경우 (설치 없이 쓰는 방법)
if not defined NODEEXE if exist "%~dp0node.exe" set "NODEEXE=%~dp0node.exe"

rem 3) 설치는 했는데 PATH 가 아직 갱신 안 된 경우
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramW6432%\nodejs\node.exe" set "NODEEXE=%ProgramW6432%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE if exist "%APPDATA%\npm\node.exe" set "NODEEXE=%APPDATA%\npm\node.exe"

if not defined NODEEXE goto :nonode

echo  Node.js 찾음: %NODEEXE%
echo.
"%NODEEXE%" server.js
echo.
echo  서버가 종료되었습니다.
pause
exit /b

:nonode
echo  ============================================================
echo   [!] Node.js 를 찾지 못했습니다.
echo  ============================================================
echo.
echo   방법 A ─ 설치하기 (권장, 한 번만 하면 됩니다)
echo     1. https://nodejs.org  접속
echo     2. 왼쪽 초록색 "LTS" 버튼 다운로드 (.msi 파일)
echo     3. 설치할 때 옵션은 전부 기본값으로 [Next] 만 누르시면 됩니다
echo     4. 설치가 끝나면 ★컴퓨터를 한 번 재부팅★ 하거나
echo        최소한 이 창을 닫았다가 다시 실행해 주세요 (PATH 갱신 필요)
echo.
echo   방법 B ─ 설치가 막혀 있는 학교 노트북이라면 (관리자 권한 불필요)
echo     1. https://nodejs.org/en/download  에서
echo        Windows / x64 / ★ZIP★ 을 골라 받습니다
echo     2. 압축을 풀면 안에 node.exe 파일이 하나 있습니다
echo     3. 그 node.exe 를 이 폴더
echo        ( %~dp0 )
echo        안에 그대로 복사해 넣고, 이 파일을 다시 더블클릭하세요
echo.
echo  ============================================================
pause
exit /b
