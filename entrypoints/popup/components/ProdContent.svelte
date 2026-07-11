<script lang="ts">
  function openBigmodel() {
    chrome.tabs.create({ url: 'https://bigmodel.cn/glm-coding' });
  }
</script>

<div class="prod-content">
  <div class="launch-card">
    <div class="launch-icon">&#128640;</div>
    <div class="launch-title">智谱 Coding Plan</div>
    <div class="launch-desc">打开智谱平台，开始抢购准备</div>
    <button class="launch-btn" onclick={openBigmodel}>
      &#9654; 开始抢购
    </button>
    <div class="launch-hint">在 bigmodel.cn 页面中使用 Captcha Pool 收集 tickets</div>
  </div>
</div>

<style>
  .prod-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .launch-card {
    text-align: center;
    max-width: 280px;
  }

  .launch-icon {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .launch-title {
    font-size: 16px;
    font-weight: 800;
    color: #1e293b;
    margin-bottom: 6px;
  }

  .launch-desc {
    font-size: 11px;
    color: #94a3b8;
    margin-bottom: 16px;
  }

  .launch-btn {
    width: 100%;
    padding: 14px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(135deg, #6366f1, #818cf8);
    color: #fff;
    font-family: inherit;
    font-size: 14px;
    font-weight: 800;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(99, 102, 241, 0.25);
    transition: all 0.2s;
  }

  .launch-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
  }

  .launch-hint {
    font-size: 9px;
    color: #94a3b8;
    margin-top: 10px;
  }
</style>
