@echo off
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行，正在安装依赖...
  call npm install
  call npm install-scripts approve electron
  pushd node_modules\electron
  node install.js
  popd
)
start "" "node_modules\electron\dist\electron.exe" .
