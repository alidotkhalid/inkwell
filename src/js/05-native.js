// ---------- desktop app bridge ----------
// In the installed app, Windows hands us real file paths. These small adapters make a path
// behave like the browser's file handles, so the rest of the code is the same in both.
const native = window.native || null;
function nativeHandle(path) {
  const name = path.split(/[\\/]/).pop();
  return {
    kind: 'file', name, path, native: true,
    requestPermission: async () => 'granted',
    getFile: async () => new File([await native.readFile(path)], name, { type: 'application/pdf' }),
    createWritable: async () => {
      let data = null;
      return { write: async (b) => { data = b; }, close: async () => { await native.writeFile(path, data); } };
    },
  };
}
if (native) {
  const cancelled = () => new DOMException('Cancelled', 'AbortError');
  window.showOpenFilePicker = async () => { const p = await native.openDialog(); if (!p) throw cancelled(); return [nativeHandle(p)]; };
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    const p = await native.saveDialog(suggestedName || 'document.pdf', S.handle?.path || null);
    if (!p) throw cancelled();
    return nativeHandle(p);
  };
  document.documentElement.classList.add('native');
}
