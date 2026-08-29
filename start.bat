@echo off
setlocal

set "APP_DIR=%~dp0apps\minecraft-companion"
if not exist "%APP_DIR%\package.json" (
  echo MineClaw desktop app was not found: "%APP_DIR%"
  exit /b 1
)

pushd "%APP_DIR%"
call npm run electron:native:prepare
if errorlevel 1 (
  set "EXIT_CODE=%ERRORLEVEL%"
  popd
  exit /b %EXIT_CODE%
)

call npm run electron:dev
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
