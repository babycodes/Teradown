window.parent.postMessage({
  type: 'teradown-download-error',
  text: document.querySelector('p').textContent
}, window.location.origin);
