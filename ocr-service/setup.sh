#!/bin/bash
cd "$(dirname "$0")"
echo "=== OCR 验证码识别服务 - 依赖安装 ==="

# Create venv if not exists
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "虚拟环境已创建"
fi

source venv/bin/activate
pip install -r requirements.txt

echo ""
echo "=== 安装完成 ==="
echo "启动 (macOS):   source venv/bin/activate && python3 ocr_server.py"
echo "启动 (Windows): venv\\Scripts\\activate && python ocr_server_win.py"
