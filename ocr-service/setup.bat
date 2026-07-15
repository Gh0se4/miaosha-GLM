@echo off
cd /d "%~dp0"
echo === OCR 验证码识别服务 - 依赖安装 ===

if not exist "venv\" (
    python -m venv venv
    echo 虚拟环境已创建
)

call venv\Scripts\activate.bat
pip install -r requirements.txt

echo.
echo === 安装完成 ===
echo 启动: venv\Scripts\activate && python ocr_server_win.py
pause
