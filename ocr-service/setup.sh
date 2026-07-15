#!/bin/bash
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate
pip install ddddocr flask opencv-python pillow numpy
echo "OCR 服务依赖安装完成"
echo "启动方式: source venv/bin/activate && python3 ocr_server.py"
