@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>&1
set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc
set RELAY_TEST_NODE=D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe
cargo test --target x86_64-pc-windows-msvc --manifest-path D:\Develop\Relay-Agent\apps\desktop\src-tauri\Cargo.toml
