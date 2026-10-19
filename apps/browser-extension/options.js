const serverInput = document.getElementById('serverUrl');
const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.local.get(['serverUrl']).then((data) => {
  serverInput.value = typeof data.serverUrl === 'string' ? data.serverUrl : '';
});

document.getElementById('save').addEventListener('click', async () => {
  const url = serverInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  if (url === '' || token === '') {
    status.textContent = 'API 地址与令牌都必须填写。';
    status.style.color = '#b00';
    return;
  }
  await chrome.storage.local.set({ serverUrl: url, token });
  status.textContent = '已保存；扩展会在几秒内重连。';
  status.style.color = '#060';
});
