"""
ddddocr 本地点选验证码识别 HTTP 服务
用于自动识别腾讯 CAPTCHA 点选验证码

启动: python3 ocr_server.py
端口: 18765
接口: POST /solve  { "image": "<base64>" } → { "success": true, "result": "x1,y1|x2,y2|x3,y3" }
"""

import base64
import io
import logging
import sys

import cv2
import numpy as np
from flask import Flask, request, jsonify
from PIL import Image, ImageDraw, ImageFont

try:
    import ddddocr
except ImportError:
    print("请先安装 ddddocr: pip3 install ddddocr")
    sys.exit(1)

app = Flask(__name__)
log = logging.getLogger('ocr-server')
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')

# ── CORS ─────────────────────────────────────────────────────────
@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response

# ── 加载模型 ──────────────────────────────────────────────────────
log.info('正在加载 ddddocr 模型...')
_det = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
_ocr = ddddocr.DdddOcr(det=False, ocr=True, show_ad=False)
log.info('模型加载完成，服务启动在 :18765')

# ── 核心逻辑 ──────────────────────────────────────────────────────

def preprocess_image(img_bytes):
    """多种预处理策略，返回增强后的图像列表"""
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    variants = [img]
    # 锐化
    kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
    variants.append(cv2.filter2D(img, -1, kernel))
    # 二值化
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
    variants.append(cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR))
    return variants

def solve(image_b64):
    """识别点选验证码，返回点击坐标序列"""
    try:
        img_bytes = base64.b64decode(image_b64)
    except Exception:
        return None

    # 1. 目标检测 — 找出所有可点击的字符区域
    all_boxes = []
    for variant in preprocess_image(img_bytes):
        _, buf = cv2.imencode('.png', variant)
        boxes = _det.detection(buf.tobytes())
        if boxes:
            all_boxes.extend(boxes)

    if not all_boxes:
        return None

    # 2. OCR 识别 — 对每个区域识别字符
    pil_img = Image.open(io.BytesIO(img_bytes))
    ocr_results = []
    for box in all_boxes:
        x1, y1, x2, y2 = box
        crop = pil_img.crop((x1, y1, x2, y2))
        buf = io.BytesIO()
        crop.save(buf, format='PNG')
        char = _ocr.classification(buf.getvalue())
        if char:
            center = ((x1 + x2) // 2, (y1 + y2) // 2)
            ocr_results.append({'char': char, 'x': center[0], 'y': center[1]})

    if not ocr_results:
        return None

    # 3. 按 X 坐标排序（从左到右）
    ocr_results.sort(key=lambda r: r['x'])
    result = '|'.join(f"{r['x']},{r['y']}" for r in ocr_results)
    return result

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True})

@app.route('/solve', methods=['POST'])
def solve_endpoint():
    try:
        data = request.get_json(force=True)
        image_b64 = data.get('image', '')
        if not image_b64:
            return jsonify({'success': False, 'error': 'missing image'})

        result = solve(image_b64)
        if result:
            return jsonify({'success': True, 'data': {'result': result}})
        else:
            return jsonify({'success': False, 'error': 'recognition failed'})
    except Exception as e:
        log.error(f'solve error: {e}')
        return jsonify({'success': False, 'error': str(e)})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=18765, debug=False)
