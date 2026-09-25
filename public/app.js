function go() {
  let input = document.getElementById('url').value.trim();
  if (!input) return;

  if (!/^https?:\/\//i.test(input)) {
    if (/\.[a-z]{2,}/i.test(input) && !input.includes(' ')) {
      input = 'https://' + input;
    } else {
      input = 'https://duckduckgo.com/?q=' + encodeURIComponent(input);
    }
  }

  document.getElementById('frame').src =
    '/proxy?url=' + encodeURIComponent(input);
}

document.getElementById('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') go();
});